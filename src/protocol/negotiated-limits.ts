import {createHash} from 'node:crypto';

import type {CanonicalJsonLimits} from './canonical-json.js';

export const PROTOCOL_LIMIT_KEYS = [
  'maxArrayItems',
  'maxBodyBytes',
  'maxCanonicalDepth',
  'maxCanonicalNodes',
  'maxEventBytes',
  'maxObjectKeys',
  'maxRecoveryItemBytes',
  'maxRecoveryItemDepth',
  'maxRecoveryItemNodes',
  'maxRecoveryPageItems',
  'maxRecoveryPageOverheadBytes',
  'maxRecoveryPageOverheadNodes',
  'maxStringBytes',
  'maxToolArgumentsBytes',
  'maxToolDescriptors',
  'maxToolResultValueBytes',
] as const;

export type ProtocolLimitKey = typeof PROTOCOL_LIMIT_KEYS[number];
export type ProtocolLimitOffer = Readonly<Record<ProtocolLimitKey, number>>;
export type EffectiveProtocolLimits = ProtocolLimitOffer;

export const RECOVERY_PAGE_DEPTH_OVERHEAD = 2;
export const MIN_RECOVERY_PAGE_OVERHEAD_BYTES = 16_384;
export const MIN_RECOVERY_PAGE_OVERHEAD_NODES = 256;
export const TOOL_PROPOSAL_ITEM_OVERHEAD_BYTES = 4096;
export const TOOL_PROPOSAL_ITEM_OVERHEAD_NODES = 64;
export const TOOL_PROPOSAL_EVENT_OVERHEAD_BYTES = 16_384;
export const TOOL_PROPOSAL_EVENT_OVERHEAD_NODES = 256;
export const MIN_PROTOCOL_OBJECT_KEYS = 32;
export const MIN_PROTOCOL_ARRAY_ITEMS = 7;

export const SNAPSHOT_CURSOR_AUTHORIZATION_FIELDS = Object.freeze([
  'algorithm',
  'keyId',
  'signature',
] as const);
export const SNAPSHOT_CURSOR_PROJECTION_FIELDS = Object.freeze([
  'collection',
  'collectionDigest',
  'expiresAt',
  'limitProfileDigest',
  'nextOffset',
  'protocolVersion',
  'sessionId',
  'snapshotId',
  'snapshotVersion',
  'tenantId',
] as const);
export const SNAPSHOT_CURSOR_COLLECTION_NAMES = Object.freeze([
  'activeGrants',
  'decisions',
  'grants',
  'operations',
  'pendingProposals',
  'proposals',
  'results',
] as const);
export const MIN_SNAPSHOT_CURSOR_TOKEN_LENGTH = 128;

let longestSnapshotCollectionName = '';
for (const collection of SNAPSHOT_CURSOR_COLLECTION_NAMES) {
  if (collection.length > longestSnapshotCollectionName.length) {
    longestSnapshotCollectionName = collection;
  }
}

const maximumSnapshotCursorV1 = {
  authorization: {
    algorithm: 'Ed25519',
    keyId: 'ffffffff-ffff-8fff-bfff-ffffffffffff',
    signature: 'A'.repeat(86),
  },
  projection: {
    collection: longestSnapshotCollectionName,
    collectionDigest: `sha256:${'f'.repeat(64)}`,
    expiresAt: '9999-12-31T23:59:59.999Z',
    limitProfileDigest: `sha256:${'f'.repeat(64)}`,
    nextOffset: Number.MAX_SAFE_INTEGER,
    protocolVersion: '1.0',
    sessionId: 'ffffffff-ffff-8fff-bfff-ffffffffffff',
    snapshotId: 'ffffffff-ffff-8fff-bfff-ffffffffffff',
    snapshotVersion: Number.MAX_SAFE_INTEGER,
    tenantId: 'ffffffff-ffff-8fff-bfff-ffffffffffff',
  },
};

// The literal's keys are in JCS order and its values use every closed v1 field's maximum encoding.
const maximumSnapshotCursorV1CanonicalJson = JSON.stringify(maximumSnapshotCursorV1);
export const MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES =
  Buffer.byteLength(maximumSnapshotCursorV1CanonicalJson, 'utf8');
export const MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH =
  Math.ceil(MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES * 4 / 3);

export const PROTOCOL_GENERATED_STRING_MAX_BYTES = Object.freeze({
  accessToken: 8192,
  base64Url32: 43,
  ed25519Signature: 86,
  nonce: 86,
  problemCode: 28,
  problemDetail: 2048,
  problemInstance: 8192,
  problemTitle: 512,
  problemType: 128,
  protocolVersion: 3,
  refreshToken: 8192,
  replayToken: 256,
  sha256Digest: 71,
  snapshotCursorToken: MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH,
  timestamp: 24,
  uuid: 36,
});
export const MIN_PROTOCOL_STRING_BYTES = Math.max(
  ...Object.values(PROTOCOL_GENERATED_STRING_MAX_BYTES),
);

export const SERVER_PROTOCOL_LIMITS: EffectiveProtocolLimits = Object.freeze({
  maxArrayItems: 1024,
  maxBodyBytes: 1_048_576,
  maxCanonicalDepth: 32,
  maxCanonicalNodes: 10_000,
  maxEventBytes: 262_144,
  maxObjectKeys: 256,
  maxRecoveryItemBytes: 786_432,
  maxRecoveryItemDepth: 30,
  maxRecoveryItemNodes: 9744,
  maxRecoveryPageItems: 128,
  maxRecoveryPageOverheadBytes: 262_144,
  maxRecoveryPageOverheadNodes: 256,
  maxStringBytes: 65_536,
  maxToolArgumentsBytes: 245_760,
  maxToolDescriptors: 128,
  maxToolResultValueBytes: 524_288,
});

export class ProtocolLimitNegotiationError extends Error {
  public readonly code = 'incompatible_limit_profile';

  constructor(
    public readonly invariant: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolLimitNegotiationError';
  }
}

function incompatible(invariant: string, message: string): never {
  throw new ProtocolLimitNegotiationError(invariant, message);
}

function assertOfferShape(offer: ProtocolLimitOffer, label: string): void {
  for (const key of PROTOCOL_LIMIT_KEYS) {
    const value = offer[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      incompatible('positive_safe_integers', `${label}.${key} must be a positive safe integer`);
    }
  }
}

function assertServerHardMaxima(limits: EffectiveProtocolLimits): void {
  for (const key of PROTOCOL_LIMIT_KEYS) {
    const value = limits[key];
    if (value > SERVER_PROTOCOL_LIMITS[key]) {
      incompatible('server_hard_maxima', `effectiveLimits.${key} exceeds the protocol 1.0 hard maximum`);
    }
  }
}

function assertAtLeast(
  limits: EffectiveProtocolLimits,
  key: ProtocolLimitKey,
  minimum: number,
  invariant: string,
): void {
  if (limits[key] < minimum) {
    incompatible(invariant, `${key} must be at least ${minimum}`);
  }
}

function assertAtMost(
  left: number,
  right: number,
  invariant: string,
  message: string,
): void {
  if (left > right) incompatible(invariant, message);
}

export function assertCompatibleProtocolLimits(limits: EffectiveProtocolLimits): void {
  assertOfferShape(limits, 'effectiveLimits');
  assertServerHardMaxima(limits);
  assertAtLeast(
    limits,
    'maxRecoveryPageOverheadBytes',
    MIN_RECOVERY_PAGE_OVERHEAD_BYTES,
    'recovery_page_byte_reserve',
  );
  assertAtLeast(
    limits,
    'maxRecoveryPageOverheadNodes',
    MIN_RECOVERY_PAGE_OVERHEAD_NODES,
    'recovery_page_node_reserve',
  );
  assertAtLeast(
    limits,
    'maxStringBytes',
    MIN_PROTOCOL_STRING_BYTES,
    'mandatory_generated_strings',
  );
  assertAtLeast(limits, 'maxObjectKeys', MIN_PROTOCOL_OBJECT_KEYS, 'protocol_object_shape');
  assertAtLeast(limits, 'maxArrayItems', MIN_PROTOCOL_ARRAY_ITEMS, 'recovery_collection_count');
  assertAtLeast(
    limits,
    'maxRecoveryItemDepth',
    2,
    'tool_argument_depth_headroom',
  );
  assertAtLeast(
    limits,
    'maxRecoveryItemNodes',
    TOOL_PROPOSAL_ITEM_OVERHEAD_NODES + 1,
    'tool_argument_node_headroom',
  );

  assertAtMost(
    limits.maxRecoveryItemBytes + limits.maxRecoveryPageOverheadBytes,
    limits.maxBodyBytes,
    'recovery_page_bytes',
    'maxBodyBytes must cover maxRecoveryItemBytes plus maxRecoveryPageOverheadBytes',
  );
  assertAtMost(
    limits.maxRecoveryItemNodes + limits.maxRecoveryPageOverheadNodes,
    limits.maxCanonicalNodes,
    'recovery_page_nodes',
    'maxCanonicalNodes must cover maxRecoveryItemNodes plus maxRecoveryPageOverheadNodes',
  );
  assertAtMost(
    limits.maxRecoveryItemDepth + RECOVERY_PAGE_DEPTH_OVERHEAD,
    limits.maxCanonicalDepth,
    'recovery_page_depth',
    `maxCanonicalDepth must exceed maxRecoveryItemDepth by ${RECOVERY_PAGE_DEPTH_OVERHEAD}`,
  );
  assertAtMost(
    limits.maxRecoveryPageItems,
    limits.maxArrayItems,
    'recovery_page_array_capacity',
    'maxRecoveryPageItems must not exceed maxArrayItems',
  );
  assertAtMost(
    limits.maxToolDescriptors,
    limits.maxArrayItems,
    'tool_descriptor_array_capacity',
    'maxToolDescriptors must not exceed maxArrayItems',
  );
  assertAtMost(
    limits.maxEventBytes,
    limits.maxBodyBytes,
    'event_body_capacity',
    'maxEventBytes must not exceed maxBodyBytes',
  );
  assertAtMost(
    limits.maxToolArgumentsBytes + TOOL_PROPOSAL_ITEM_OVERHEAD_BYTES,
    limits.maxRecoveryItemBytes,
    'tool_proposal_recovery_bytes',
    'maxRecoveryItemBytes must cover maxToolArgumentsBytes plus signed proposal overhead',
  );
  assertAtMost(
    limits.maxToolArgumentsBytes + TOOL_PROPOSAL_EVENT_OVERHEAD_BYTES,
    limits.maxEventBytes,
    'tool_proposal_event_bytes',
    'maxEventBytes must cover maxToolArgumentsBytes plus signed event overhead',
  );
  assertAtMost(
    limits.maxToolResultValueBytes,
    limits.maxBodyBytes,
    'tool_result_body_capacity',
    'maxToolResultValueBytes must not exceed maxBodyBytes',
  );
  assertAtMost(
    TOOL_PROPOSAL_ITEM_OVERHEAD_NODES,
    limits.maxRecoveryItemNodes - 1,
    'tool_proposal_recovery_nodes',
    'maxRecoveryItemNodes must leave room for tool arguments',
  );
  assertAtMost(
    TOOL_PROPOSAL_EVENT_OVERHEAD_NODES,
    limits.maxCanonicalNodes - 1,
    'tool_proposal_event_nodes',
    'maxCanonicalNodes must leave room for a signed tool proposal event',
  );
}

export function negotiateProtocolLimits(
  first: ProtocolLimitOffer,
  second: ProtocolLimitOffer,
): EffectiveProtocolLimits {
  assertOfferShape(first, 'firstOffer');
  assertOfferShape(second, 'secondOffer');
  const entries = PROTOCOL_LIMIT_KEYS.map(
    (key) => [key, Math.min(first[key], second[key])] as const,
  );
  const effective = Object.freeze(Object.fromEntries(entries)) as EffectiveProtocolLimits;
  assertCompatibleProtocolLimits(effective);
  return effective;
}

export function protocolLimitProfileDigest(limits: EffectiveProtocolLimits): string {
  assertCompatibleProtocolLimits(limits);
  const canonical = `{${[...PROTOCOL_LIMIT_KEYS]
    .sort()
    .map((key) => `${JSON.stringify(key)}:${limits[key]}`)
    .join(',')}}`;
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function canonicalLimits(
  limits: EffectiveProtocolLimits,
  overrides: Partial<CanonicalJsonLimits> = {},
): Readonly<CanonicalJsonLimits> {
  assertCompatibleProtocolLimits(limits);
  return Object.freeze({
    maxArrayLength: limits.maxArrayItems,
    maxDepth: limits.maxCanonicalDepth,
    maxNodes: limits.maxCanonicalNodes,
    maxObjectKeys: limits.maxObjectKeys,
    maxPayloadBytes: limits.maxBodyBytes,
    maxStringBytes: limits.maxStringBytes,
    ...overrides,
  });
}

export function bodyCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits);
}

export function eventCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits, {maxPayloadBytes: limits.maxEventBytes});
}

export function recoveryItemCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits, {
    maxDepth: limits.maxRecoveryItemDepth,
    maxNodes: limits.maxRecoveryItemNodes,
    maxPayloadBytes: limits.maxRecoveryItemBytes,
  });
}

export function toolArgumentsCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits, {
    maxDepth: limits.maxRecoveryItemDepth - 1,
    maxNodes: Math.min(
      limits.maxRecoveryItemNodes - TOOL_PROPOSAL_ITEM_OVERHEAD_NODES,
      limits.maxCanonicalNodes - TOOL_PROPOSAL_EVENT_OVERHEAD_NODES,
    ),
    maxPayloadBytes: limits.maxToolArgumentsBytes,
  });
}

export function toolResultValueCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits, {maxPayloadBytes: limits.maxToolResultValueBytes});
}
