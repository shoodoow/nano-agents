import type Dockerode from "dockerode";

/**
 * Address ranges an account container may not open connections to.
 * Why: these are the machine the core runs on, its local network, other
 * accounts' containers on the same Docker bridge, and cloud metadata
 * services. Agents need the public internet and nothing else.
 */
export const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

export const BLOCKED_V6 = ["fc00::/7", "fe80::/10", "ff00::/8", "::ffff:0:0/96"];

/** Exit code the script uses when the image has no iptables. */
const NO_IPTABLES = 90;

/**
 * Builds the shell script that closes one container's network.
 * Outbound: loopback and DNS to the container's own resolvers pass, every
 * other private destination is rejected. Inbound: only loopback and replies
 * pass, because the core reaches a container through `docker exec`, never
 * over the network. The script can run again at any time: it empties and
 * refills its own two chains.
 */
export function firewallScript(): string {
  const chains = (tool: string, blocked: string[], dns: string): string[] => [
    `${tool} -N NANO-OUT 2>/dev/null || ${tool} -F NANO-OUT`,
    `${tool} -N NANO-IN 2>/dev/null || ${tool} -F NANO-IN`,
    `${tool} -A NANO-OUT -o lo -j RETURN`,
    dns,
    ...blocked.map((range) => `${tool} -A NANO-OUT -d ${range} -j REJECT`),
    `${tool} -A NANO-IN -i lo -j RETURN`,
    `${tool} -A NANO-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`,
    `${tool} -A NANO-IN -j DROP`,
    `${tool} -C OUTPUT -j NANO-OUT 2>/dev/null || ${tool} -I OUTPUT 1 -j NANO-OUT`,
    `${tool} -C INPUT -j NANO-IN 2>/dev/null || ${tool} -I INPUT 1 -j NANO-IN`,
  ];
  // A resolver on a private address (Docker Desktop, a home router) stays
  // reachable on port 53 only, so name lookups keep working.
  const dns = [
    `for ns in $(awk '$1=="nameserver"{print $2}' /etc/resolv.conf | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'); do`,
    `  iptables -A NANO-OUT -d "$ns" -p udp --dport 53 -j RETURN`,
    `  iptables -A NANO-OUT -d "$ns" -p tcp --dport 53 -j RETURN`,
    "done",
  ].join("\n");
  return [
    "set -e",
    `command -v iptables >/dev/null || exit ${NO_IPTABLES}`,
    ...chains("iptables", BLOCKED_V4, dns),
    // IPv6 is usually off in a container. The rules are required only when
    // the container really has a routable IPv6 address.
    // `set -e` does not apply inside an `if` test, so the steps are chained.
    `if ! { ${chains("ip6tables", BLOCKED_V6, ":").map((step) => `{ ${step}; }`).join(" && ")}; } 2>/dev/null; then`,
    `  if grep -qE '^[0-9a-f]{32} [0-9a-f]+ [0-9a-f]+ 00 ' /proc/net/if_inet6 2>/dev/null; then`,
    '    echo "The IPv6 rules could not be installed." >&2; exit 1',
    "  fi",
    "fi",
  ].join("\n");
}

/**
 * Installs the network rules in one running container.
 * Why a second container: changing firewall rules needs the NET_ADMIN
 * capability, and the account container must not hold it, or an agent with
 * root could remove the rules. A short-lived helper joins the account
 * container's network, installs the rules and exits.
 * Input: the Docker client, the image to run the helper from, the account
 * container's name, and labels for the helper.
 * Output: nothing. Throws when the rules were not installed.
 */
export async function applyFirewall(
  docker: Dockerode,
  image: string,
  containerName: string,
  labels: Record<string, string>,
): Promise<void> {
  await runHelper(docker, image, firewallScript(), `container:${containerName}`, labels, containerName);
}

/** The Docker network every account container joins when the rules live on the host. */
export const ACCOUNT_NETWORK = "nano-accounts";
/** That network's bridge interface on the host, named so the rules can match it. */
export const ACCOUNT_BRIDGE = "nano0";

/**
 * Creates the account network when it does not exist yet.
 * Containers on it cannot talk to each other (`enable_icc` off), and its
 * bridge has a fixed name the host rules match on.
 */
export async function ensureAccountNetwork(docker: Dockerode): Promise<void> {
  try {
    await docker.getNetwork(ACCOUNT_NETWORK).inspect();
    return;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  try {
    await docker.createNetwork({
      Name: ACCOUNT_NETWORK,
      Driver: "bridge",
      Options: {
        "com.docker.network.bridge.name": ACCOUNT_BRIDGE,
        "com.docker.network.bridge.enable_icc": "false",
      },
      Labels: { "nano.network": "accounts" },
    });
  } catch (error) {
    // Another call created it first.
    if ((error as { statusCode?: number }).statusCode !== 409) throw error;
  }
}

/**
 * Builds the script that closes the account network from the host side.
 * Why a second way: a virtual-machine runtime such as Kata moves a
 * container's traffic past the rules in its own network namespace, so
 * there the rules must sit on the host, on the bridge every account
 * container is attached to. Traffic from that bridge may go to the public
 * internet only: not to the host itself, not to private addresses, and not
 * back to the bridge. The two chains are replaced in one step, so there is
 * no moment without rules.
 */
export function hostFirewallScript(): string {
  const restore = (blocked: string[], hostAllow: string[] = []) =>
    [
      "*filter",
      ":NANO-FWD - [0:0]",
      ":NANO-IN - [0:0]",
      `-A NANO-FWD -o ${ACCOUNT_BRIDGE} -j DROP`,
      ...blocked.map((range) => `-A NANO-FWD -d ${range} -j REJECT`),
      "-A NANO-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
      ...hostAllow,
      "-A NANO-IN -j DROP",
      "COMMIT",
    ].join("\n");
  const jumps = (tool: string) =>
    [
      // Docker keeps DOCKER-USER ahead of its own forwarding rules; without Docker's chain, go first in FORWARD.
      `parent=FORWARD; if ${tool} -S DOCKER-USER >/dev/null 2>&1; then parent=DOCKER-USER; fi`,
      `${tool} -C "$parent" -i ${ACCOUNT_BRIDGE} -j NANO-FWD 2>/dev/null || ${tool} -I "$parent" 1 -i ${ACCOUNT_BRIDGE} -j NANO-FWD`,
      `${tool} -C INPUT -i ${ACCOUNT_BRIDGE} -j NANO-IN 2>/dev/null || ${tool} -I INPUT 1 -i ${ACCOUNT_BRIDGE} -j NANO-IN`,
    ].join("\n");
  return [
    "set -e",
    `command -v iptables-restore >/dev/null || exit ${NO_IPTABLES}`,
    `iptables-restore --noflush <<'RULES'\n${restore(BLOCKED_V4)}\nRULES`,
    jumps("iptables"),
    // The account network has no IPv6 unless an operator adds it; the rules are required only then.
    // IPv6 needs ICMP to the host to find its router at all.
    `if ! { ip6tables-restore --noflush <<'RULES'\n${restore(BLOCKED_V6, ["-A NANO-IN -p ipv6-icmp -j RETURN"])}\nRULES\n} 2>/dev/null || ! { ${jumps("ip6tables").split("\n").map((step) => `{ ${step}; }`).join(" && ")}; } 2>/dev/null; then`,
    `  if grep -q ' ${ACCOUNT_BRIDGE}$' /proc/net/if_inet6 2>/dev/null && grep -E ' ${ACCOUNT_BRIDGE}$' /proc/net/if_inet6 | grep -qE '^[0-9a-f]{32} [0-9a-f]+ [0-9a-f]+ 00 '; then`,
    '    echo "The IPv6 rules could not be installed." >&2; exit 1',
    "  fi",
    "fi",
  ].join("\n");
}

/**
 * Installs the host-side rules for the account network.
 * Input: the Docker client, the helper image, and labels for the helper.
 * Output: nothing. Throws when the rules were not installed.
 */
export async function applyHostFirewall(docker: Dockerode, image: string, labels: Record<string, string>): Promise<void> {
  await runHelper(docker, image, hostFirewallScript(), "host", labels, `the ${ACCOUNT_NETWORK} network`);
}

/** Runs one rules script in a helper that holds NET_ADMIN and nothing else, then removes the helper. */
async function runHelper(
  docker: Dockerode,
  image: string,
  script: string,
  networkMode: string,
  labels: Record<string, string>,
  target: string,
): Promise<void> {
  await removeFinishedHelpers(docker);
  const helper = await docker.createContainer({
    Image: image,
    Cmd: ["sh", "-c", script],
    User: "root",
    Labels: { ...labels, "nano.helper": "firewall" },
    HostConfig: {
      NetworkMode: networkMode,
      CapDrop: ["ALL"],
      CapAdd: ["NET_ADMIN"],
    },
  });
  try {
    await helper.start();
    const { StatusCode: code } = (await helper.wait()) as { StatusCode: number };
    if (code === 0) return;
    if (code === NO_IPTABLES) {
      throw new Error(
        `Linux image ${image} has no iptables, so the container network cannot be closed. Rebuild it: docker build -t ${image} apps/core/linux`,
      );
    }
    const output = (await helper.logs({ stdout: true, stderr: true })).toString("utf8").replace(/[^\x20-\x7e\n]/g, "");
    throw new Error(`The network rules for ${target} were not installed (exit ${code}). ${output.trim().slice(-400)}`);
  } finally {
    await helper.remove({ force: true }).catch(() => undefined);
  }
}

/** Removes helpers left behind when the core stopped before it could remove them. */
async function removeFinishedHelpers(docker: Dockerode): Promise<void> {
  const finished = await docker.listContainers({ all: true, filters: { label: ["nano.helper=firewall"], status: ["exited", "dead"] } });
  await Promise.all(finished.map((helper) => docker.getContainer(helper.Id).remove({ force: true }).catch(() => undefined)));
}
