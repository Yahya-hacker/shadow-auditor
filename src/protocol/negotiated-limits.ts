import {createHash} from 'node:crypto';

import type {CanonicalJsonLimits} from './canonical-json.js';

import {
  CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD,
  MIN_TOOL_ARGUMENT_NODES,
  MINIMUM_OPERATIONAL_LIMITS,
  OPERATIONAL_LIMIT_KEYS,
  PROTOCOL_LIMIT_KEYS,
  PROTOCOL_STRUCTURAL_PROFILE,
  RECOVERY_PAGE_DEPTH_OVERHEAD,
  SERVER_OPERATIONAL_LIMITS,
  STRUCTURAL_LIMIT_KEYS,
  TOOL_INPUT_SCHEMA_MAX_DEPTH,
  TOOL_PROPOSAL_EVENT_OVERHEAD_BYTES,
  TOOL_PROPOSAL_EVENT_OVERHEAD_NODES,
  TOOL_PROPOSAL_ITEM_OVERHEAD_BYTES,
  TOOL_PROPOSAL_ITEM_OVERHEAD_NODES,
} from './generated/profile.js';

export {
  CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD,
  MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES,
  MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH,
  MIN_PROTOCOL_ARRAY_ITEMS,
  MIN_PROTOCOL_CANONICAL_DEPTH,
  MIN_PROTOCOL_OBJECT_KEYS,
  MIN_PROTOCOL_STRING_BYTES,
  MIN_RECOVERY_ITEM_DEPTH,
  MIN_RECOVERY_PAGE_OVERHEAD_BYTES,
  MIN_RECOVERY_PAGE_OVERHEAD_NODES,
  MIN_SNAPSHOT_CURSOR_TOKEN_LENGTH,
  MIN_TOOL_ARGUMENT_NODES,
  MINIMUM_OPERATIONAL_LIMITS,
  OPERATIONAL_LIMIT_KEYS,
  PROTOCOL_GENERATED_STRING_MAX_BYTES,
  PROTOCOL_LIMIT_KEYS,
  PROTOCOL_MANDATORY_DTO_COUNT,
  PROTOCOL_MANIFEST_FILE_COUNT,
  PROTOCOL_STRUCTURAL_PROFILE,
  RECOVERY_PAGE_DEPTH_OVERHEAD,
  REQUIRED_PROTOCOL_FEATURES,
  SERVER_OPERATIONAL_LIMITS,
  SNAPSHOT_CURSOR_AUTHORIZATION_FIELDS,
  SNAPSHOT_CURSOR_COLLECTION_NAMES,
  SNAPSHOT_CURSOR_PROJECTION_FIELDS,
  STRUCTURAL_LIMIT_KEYS,
  TOOL_INPUT_SCHEMA_MAX_DEPTH,
  TOOL_PROPOSAL_EVENT_OVERHEAD_BYTES,
  TOOL_PROPOSAL_EVENT_OVERHEAD_NODES,
  TOOL_PROPOSAL_ITEM_OVERHEAD_BYTES,
  TOOL_PROPOSAL_ITEM_OVERHEAD_NODES,
} from './generated/profile.js';

export type StructuralLimitKey = typeof STRUCTURAL_LIMIT_KEYS[number];
export type OperationalLimitKey = typeof OPERATIONAL_LIMIT_KEYS[number];
export type ProtocolLimitKey = typeof PROTOCOL_LIMIT_KEYS[number];
export type ProtocolStructuralProfile =
  Readonly<Record<StructuralLimitKey, number>>;
export type OperationalLimitOffer =
  Readonly<Record<OperationalLimitKey, number>>;
export type ProtocolLimitOffer = OperationalLimitOffer;
export type EffectiveProtocolLimits =
  Readonly<Record<ProtocolLimitKey, number>>;

function effectiveProtocolLimits(
  operational: OperationalLimitOffer,
): EffectiveProtocolLimits {
  return Object.freeze({
    ...PROTOCOL_STRUCTURAL_PROFILE,
    ...operational,
  });
}

export const MINIMUM_PROTOCOL_LIMITS =
  effectiveProtocolLimits(MINIMUM_OPERATIONAL_LIMITS);

export const SERVER_PROTOCOL_LIMITS =
  effectiveProtocolLimits(SERVER_OPERATIONAL_LIMITS);

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

function assertExactKeys(
  value: Readonly<Record<string, number>>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length
    || actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    incompatible(
      'operational_offer_shape',
      `${label} must contain exactly the frozen Protocol 1.0 operational quota keys`,
    );
  }
}

function assertOperationalOfferShape(
  offer: OperationalLimitOffer,
  label: string,
): void {
  assertExactKeys(offer, OPERATIONAL_LIMIT_KEYS, label);
  for (const key of OPERATIONAL_LIMIT_KEYS) {
    const value = offer[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      incompatible('positive_safe_integers', `${label}.${key} must be a positive safe integer`);
    }
  }
}

function assertServerHardMaxima(limits: EffectiveProtocolLimits): void {
  for (const key of OPERATIONAL_LIMIT_KEYS) {
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
  assertExactKeys(limits, PROTOCOL_LIMIT_KEYS, 'effectiveLimits');
  for (const key of PROTOCOL_LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      incompatible(
        'positive_safe_integers',
        `effectiveLimits.${key} must be a positive safe integer`,
      );
    }
  }

  for (const key of STRUCTURAL_LIMIT_KEYS) {
    if (limits[key] !== PROTOCOL_STRUCTURAL_PROFILE[key]) {
      incompatible(
        'frozen_structural_profile',
        `${key} must equal the frozen Protocol 1.0 value ${PROTOCOL_STRUCTURAL_PROFILE[key]}`,
      );
    }
  }

  assertServerHardMaxima(limits);
  const minimumInvariants: Readonly<Record<OperationalLimitKey, string>> = {
    maxBodyBytes: 'mandatory_protocol_body',
    maxEventBytes: 'mandatory_protocol_event',
    maxRecoveryItemBytes: 'mandatory_recovery_item_bytes',
    maxRecoveryPageItems: 'mandatory_recovery_page_items',
    maxToolArgumentsBytes: 'mandatory_tool_argument_bytes',
    maxToolDescriptors: 'mandatory_tool_descriptors',
    maxToolResultValueBytes: 'mandatory_tool_result_bytes',
  };
  for (const key of OPERATIONAL_LIMIT_KEYS) {
    assertAtLeast(limits, key, MINIMUM_PROTOCOL_LIMITS[key], minimumInvariants[key]);
  }

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
    TOOL_INPUT_SCHEMA_MAX_DEPTH + CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD,
    limits.maxCanonicalDepth,
    'create_session_descriptor_depth',
    'maxCanonicalDepth must cover the bounded tool input schema plus its CreateSessionRequest embedding',
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
    TOOL_PROPOSAL_ITEM_OVERHEAD_NODES + MIN_TOOL_ARGUMENT_NODES,
    limits.maxRecoveryItemNodes,
    'tool_proposal_recovery_nodes',
    `maxRecoveryItemNodes must leave room for ${MIN_TOOL_ARGUMENT_NODES} tool argument nodes`,
  );
  assertAtMost(
    TOOL_PROPOSAL_EVENT_OVERHEAD_NODES + MIN_TOOL_ARGUMENT_NODES,
    limits.maxCanonicalNodes,
    'tool_proposal_event_nodes',
    `maxCanonicalNodes must leave room for ${MIN_TOOL_ARGUMENT_NODES} tool argument nodes in a signed event`,
  );
}

export function negotiateProtocolLimits(
  first: OperationalLimitOffer,
  second: OperationalLimitOffer,
): EffectiveProtocolLimits {
  assertOperationalOfferShape(first, 'firstOffer');
  assertOperationalOfferShape(second, 'secondOffer');
  const entries = OPERATIONAL_LIMIT_KEYS.map(
    (key) => [key, Math.min(first[key], second[key])] as const,
  );
  const effective = effectiveProtocolLimits(
    Object.freeze(Object.fromEntries(entries)) as OperationalLimitOffer,
  );
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

export function toolInputSchemaCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits, {maxDepth: TOOL_INPUT_SCHEMA_MAX_DEPTH});
}

export function toolResultValueCanonicalLimits(
  limits: EffectiveProtocolLimits,
): Readonly<CanonicalJsonLimits> {
  return canonicalLimits(limits, {maxPayloadBytes: limits.maxToolResultValueBytes});
}
