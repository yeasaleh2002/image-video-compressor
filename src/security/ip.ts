/**
 * @file Isomorphic IP address classification for SSRF protection.
 *
 * Blocks every non-public range from the IANA special-purpose registries, and
 * unwraps IPv6 encodings that smuggle an IPv4 address (IPv4-mapped `::ffff:`,
 * IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) so
 * `http://[::ffff:127.0.0.1]/` cannot slip past an IPv4 deny-list.
 *
 * Obfuscated IPv4 literals (`2130706433`, `0x7f.1`, `017700000001`) are
 * normalised to dotted-quad by the WHATWG URL parser before they reach here.
 */

type Cidr4 = [number, number]; // [network as uint32, prefix]

const V4_BLOCKED: Cidr4[] = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata: 169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
].map(([ip, p]) => [parseV4(ip as string)!, p as number]);

/** Parses strict dotted-quad IPv4 into a uint32, or `null`. */
export function parseV4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function v4InCidr(ip: number, [net, prefix]: Cidr4): boolean {
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (net & mask) >>> 0;
}

/** Parses IPv6 (optionally with an embedded IPv4 tail / zone id) into 8 hextets, or `null`. */
export function parseV6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return null;

  // Convert an embedded dotted IPv4 tail into two hextets.
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

function isBlockedV4(n: number): boolean {
  return V4_BLOCKED.some((c) => v4InCidr(n, c));
}

function isBlockedV6(h: number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, hh = 0] = h;
  const embedded = ((g << 16) >>> 0) + hh;
  const allZeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;

  if (allZeroPrefix && f === 0 && g === 0 && (hh === 0 || hh === 1)) return true; // :: and ::1
  if (allZeroPrefix && f === 0xffff) return isBlockedV4(embedded);               // ::ffff:a.b.c.d
  if (allZeroPrefix && f === 0) return isBlockedV4(embedded);                    // ::a.b.c.d (deprecated)
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isBlockedV4(embedded); // NAT64
  if (a === 0x2002) return isBlockedV4(((b << 16) >>> 0) + c);                    // 6to4
  if ((a & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true;   // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard-only
  return false;
}

/** Returns `true` if the value is an IP literal (v4 or v6). */
export function isIpLiteral(host: string): boolean {
  return parseV4(host) !== null || parseV6(host) !== null;
}

/**
 * Returns `true` when the address must never be contacted.
 * Unparseable input is treated as blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4 !== null) return isBlockedV4(v4);
  const v6 = parseV6(ip);
  if (v6 !== null) return isBlockedV6(v6);
  return true;
}
