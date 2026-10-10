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
  const helper = await docker.createContainer({
    Image: image,
    Cmd: ["sh", "-c", firewallScript()],
    User: "root",
    Labels: { ...labels, "nano.helper": "firewall" },
    HostConfig: {
      NetworkMode: `container:${containerName}`,
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
    throw new Error(`The network rules for ${containerName} were not installed (exit ${code}). ${output.trim().slice(-400)}`);
  } finally {
    await helper.remove({ force: true }).catch(() => undefined);
  }
}
