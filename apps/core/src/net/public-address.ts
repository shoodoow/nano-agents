import { BlockList, isIP } from "node:net";

/**
 * Addresses that are never a public internet host: loopback, private ranges,
 * link-local (cloud metadata lives at 169.254.169.254), carrier NAT,
 * multicast, and their IPv6 counterparts. IPv4-mapped IPv6 addresses are
 * matched against the IPv4 rules by BlockList itself.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

const LOCAL_NAMES = new Set(["localhost", "host.docker.internal", "metadata.google.internal"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

/** True when a literal IP address is loopback, private, link-local or otherwise not public. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * True when a URL hostname names this machine or a private network.
 * Why: one rule for every place a person or a model supplies a URL. It reads
 * the name only; a public name that resolves to a private address is caught
 * when the connection is made (see public-fetch.ts).
 * Input: a hostname as `new URL(x).hostname` returns it (IPv6 in brackets).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (LOCAL_NAMES.has(host) || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateAddress(host);
}
