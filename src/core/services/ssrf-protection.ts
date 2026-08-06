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

  const family = isIP(normalized);
  return family > 0 && blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
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
