/**
 * URL safety for the "fetch a page" feature.
 *
 * Letting a user hand a server a URL to fetch is server-side request forgery by
 * default. The server sits inside a network the user does not have: cloud
 * metadata on 169.254.169.254, internal services on RFC1918, anything bound to
 * localhost. So the check is an allowlist of schemes and ports plus a denylist
 * of address ranges, applied at three points:
 *
 *   1. the literal URL the user typed;
 *   2. the IP addresses its hostname actually resolves to - a name the attacker
 *      controls can simply have an A record of 127.0.0.1;
 *   3. every redirect hop, because a permitted host is free to 302 to the
 *      metadata endpoint. Redirects are followed manually for this reason.
 *
 * Everything here is pure and synchronous so it can be tested without a network
 * or a resolver; the DNS step takes an injected lookup function.
 */

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** Only these. No ftp:, no file:, no gopher:, no data:. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Only the web ports. Blocks using the fetcher as an internal port scanner. */
const ALLOWED_PORTS = new Set(['', '80', '443']);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Parse a dotted-quad into four octets, or null if it is not one. */
export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** True when an IPv4 address is loopback, private, link-local or reserved. */
export function isBlockedIPv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (a === 0) return true;                                  // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                 // private
  if (a === 127) return true;                                // loopback
  if (a === 169 && b === 254) return true;                   // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;          // private
  if (a === 192 && b === 168) return true;                   // private
  if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT
  if (a === 192 && b === 0 && c === 0) return true;          // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true;          // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;      // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;       // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;        // TEST-NET-3
  if (a >= 224) return true;                                 // multicast, reserved, broadcast
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

/** True when an IPv6 address is loopback, unspecified, ULA, link-local or multicast. */
export function isBlockedIPv6(value: string): boolean {
  const addr = value.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0] ?? '';
  if (addr === '::1' || addr === '::' || addr.length === 0) return true;

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms tunnel straight
  // through an IPv6-only check, so unwrap and re-test as IPv4.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(addr);
  if (mapped) {
    const octets = parseIPv4(mapped[1]!);
    if (octets && isBlockedIPv4(octets)) return true;
  }

  const head = addr.split(':')[0] ?? '';
  if (head.length === 0) return false;
  const group = Number.parseInt(head.padEnd(4, '0'), 16);
  if (Number.isNaN(group)) return false;
  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((group & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True when a literal IP string (v4 or v6) is in a blocked range. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isBlockedIPv4(v4);
  if (ip.includes(':')) return isBlockedIPv6(ip);
  return false;
}

/**
 * Check a URL string before any request is made.
 *
 * This is the syntactic gate only. A hostname that passes here still has to
 * clear `assertResolvesPublicly` before it is fetched.
 */
export function assessUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That is not a valid URL. Include http:// or https://.' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Only http and https URLs are fetched, not "${url.protocol}".` };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: `Only ports 80 and 443 are fetched, not ${url.port}.` };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length === 0) return { ok: false, reason: 'That URL has no hostname.' };
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    return { ok: false, reason: 'That hostname points at this server, so it will not be fetched.' };
  }
  if (isBlockedAddress(hostname)) {
    return { ok: false, reason: 'That address is on a private or reserved network.' };
  }
  return { ok: true, url };
}

export interface ResolvedAddress {
  address: string;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Resolve a hostname and reject if ANY answer is a blocked address.
 *
 * Any, not all: a name that resolves to one public and one private address is a
 * DNS-rebinding attempt, and the fetch would be free to use either.
 */
export async function assertResolvesPublicly(hostname: string, lookup: LookupFn): Promise<void> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new Error(`Could not resolve "${hostname}".`);
  }
  if (addresses.length === 0) throw new Error(`"${hostname}" did not resolve to any address.`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`"${hostname}" resolves to ${address}, which is on a private or reserved network.`);
    }
  }
}
