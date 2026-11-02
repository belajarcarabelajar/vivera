// LAN gate: a request is served only when it comes from a private IPv4 subnet that one of
// this PC's own network interfaces is on (home Wi-Fi/Ethernet). Everything else is refused.
import { networkInterfaces } from "node:os";

export type Subnet = { base: number; mask: number; cidr: string };

const PRIVATE: Array<[string, number]> = [
  // secrets: allow private-range table of the LAN gate
  ["10.0.0.0", 8],
  // secrets: allow private-range table of the LAN gate
  ["172.16.0.0", 12],
  // secrets: allow private-range table of the LAN gate
  ["192.168.0.0", 16],
];

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function maskOf(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** "::ffff:1.2.3.4" (IPv4-mapped IPv6, as Bun reports it) -> "1.2.3.4". */
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return PRIVATE.some(([b, bits]) => ((n & maskOf(bits)) >>> 0) === ipv4ToInt(b));
}

export function subnetOf(address: string, prefix: number): Subnet | null {
  const n = ipv4ToInt(address);
  if (n === null || prefix < 8 || prefix > 30) return null;
  const mask = maskOf(prefix);
  const base = (n & mask) >>> 0;
  const b = [base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join(".");
  return { base, mask, cidr: `${b}/${prefix}` };
}

/** Private IPv4 subnets of this machine's interfaces (loopback and container bridges excluded). */
export function localSubnets(ifaces = networkInterfaces()): Subnet[] {
  const out: Subnet[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/^(lo|docker|br-|veth|virbr|tailscale|wg)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || !isPrivateIpv4(a.address)) continue;
      const prefix = Number(String(a.cidr ?? "").split("/")[1]);
      const s = subnetOf(a.address, prefix);
      if (s && !out.some((o) => o.cidr === s.cidr)) out.push(s);
    }
  }
  return out;
}

export function isAllowedClient(rawIp: string, subnets: Subnet[]): boolean {
  const ip = normalizeIp(rawIp);
  if (!isPrivateIpv4(ip)) return false;
  const n = ipv4ToInt(ip)!;
  return subnets.some((s) => ((n & s.mask) >>> 0) === s.base);
}
