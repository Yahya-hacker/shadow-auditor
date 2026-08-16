/**
 * SSRF Protection — URL validation and private-host blocking.
 *
 * Prevents the MCP HTTP invoker from connecting to internal services
 * (loopback, link-local, private RFC 1918 ranges). Extracted from agent.ts
 * so it can be unit-tested and reused by other network-facing modules.
 */

/**
 * Block connections to hosts that are clearly internal/private.
 * Prevents SSRF attacks where a compromised MCP endpoint URL points
 * to internal services.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export interface ResolvedExternalUrl {
  address: string;
  family: 4 | 6;
  url: URL;
}

export function isBlockedHost(hostname: string): boolean {
  const normalized = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost') return true;

  // Reject the entire IPv4-mapped range, not only dotted forms. Node
  // canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1 before validation.
  if (normalized.startsWith('::ffff:') || /^(?:0{1,4}:){5}ffff:/.test(normalized)) return true;

  // IPv4-compatible IPv6 addresses (::192.168.1.1, ::c0a8:101) are deprecated
  // but some hosts still route them to IPv4, so Node's BlockList does not
  // match them. Extract the embedded IPv4 and re-check that address against
  // the same private-network rules.
  const embeddedIpv4 = extractIpv4Compatible(normalized);
  if (embeddedIpv4) return isBlockedHost(embeddedIpv4);

  const family = isIP(normalized);
  return family > 0 && blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Return the IPv4 portion of an IPv4-compatible IPv6 address when the high 96
 * bits are all zero and the trailing 32 bits encode a valid IPv4 address
 * (e.g. ::192.168.1.1, ::c0a8:101), otherwise undefined. Node's BlockList
 * matches the IPv4-mapped form (::ffff:a.b.c.d) natively but NOT the
 * IPv4-compatible form, so this re-derives the embedded IPv4 for re-checking.
 */
function extractIpv4Compatible(address: string): string | undefined {
  const groups = expandHextets(address);
  if (!groups) return undefined;
  // First six hextets = upper 96 bits; must all be zero (IPv4-compatible, not
  // multicast / multicast / documentation / mapped form).
  if (groups.slice(0, 6).some((group) => group !== 0)) return undefined;
  const upper = groups[6]!;
  const lower = groups[7]!;
  return `${(upper >> 8) & 0xff}.${upper & 0xff}.${(lower >> 8) & 0xff}.${lower & 0xff}`;
}

/**
 * Expand an IPv6 literal (compressed or not, dotted or hex trailing group)
 * into 8 numeric hextets, or undefined if not a clean IPv6 literal.
 */
function expandHextets(address: string): number[] | undefined {
  if (!address || isIP(address) !== 6) return undefined;

  // Replace the dotted IPv4 tail with its two-hextet hex form (A.B.C.D as the
    // trailing 32 bits → A*256+B : C*256+D) so the whole string splits cleanly
    // into exactly 8 hextets with the IPv4 in the final two positions.
    const dotted = address.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/);
    let groupsText = address;
    if (dotted) {
      const octets = dotted[1]!.split('.').map((octet) => Number.parseInt(octet, 10));
      if (octets.length !== 4 || octets.some((octet) => octet > 255)) return undefined;
      const [a, b, c, d] = octets as [number, number, number, number];
      groupsText =
        address.slice(0, -dotted[1]!.length) +
        `${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
    }

  const leftPart = groupsText.split('::');
  if (leftPart.length > 2) return undefined;
  const [leftText, rightText] = leftPart.length === 2 ? leftPart : [groupsText, undefined];
  const left = leftText ? leftText.split(':').filter(Boolean) : [];
  const right = rightText ? rightText.split(':').filter(Boolean) : [];
  const toGroups = (list: string[]) =>
    list.map((part) => {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return NaN;
      return Number.parseInt(part, 16);
    });
  const leftGroups = toGroups(left);
  const rightGroups = toGroups(right);
  if (leftGroups.some(Number.isNaN) || rightGroups.some(Number.isNaN)) return undefined;
  if (leftGroups.length + rightGroups.length > 8) return undefined;

  if (!rightText) {
    // No "::" present: 8 groups expected. isIP(literal)===6 guarantees a full
    // valid IPv6 literal, so once the dotted tail (if any) is expanded we must
    // have exactly 8 groups here.
    if (leftGroups.length !== 8) return undefined;
    return leftGroups;
  }

  const padding = 8 - leftGroups.length - rightGroups.length;
  if (padding < 0) return undefined;
  return [...leftGroups, ...Array.from({length: padding}, () => 0), ...rightGroups];
}

/**
 * Parse and validate a URL, returning null if it's invalid or points to
 * a blocked internal host.
 */
export function validateExternalUrl(rawUrl: string): null | URL {
  const normalized = rawUrl.trim();
  if (!normalized) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      isBlockedHost(parsed.hostname)) {
    return null;
  }

  return parsed;
}

export async function validateResolvedExternalUrl(rawUrl: string): Promise<null | URL> {
  const resolved = await resolveExternalUrl(rawUrl);
  return resolved?.url ?? null;
}

/**
 * Resolve a validated external URL once and return the exact public address
 * that the transport must use. Pinning this address prevents DNS rebinding
 * between policy validation and socket creation.
 */
export async function resolveExternalUrl(rawUrl: string): Promise<null | ResolvedExternalUrl> {
  const parsed = validateExternalUrl(rawUrl);
  if (!parsed) return null;
  const hostname = parsed.hostname.replaceAll(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily > 0) {
    return {
      address: hostname,
      family: literalFamily as 4 | 6,
      url: parsed,
    };
  }

  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isBlockedHost(address))) return null;
    const selected = addresses[0]!;
    return {
      address: selected.address,
      family: selected.family as 4 | 6,
      url: parsed,
    };
  } catch {
    return null;
  }
}
