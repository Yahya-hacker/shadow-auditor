import {expect} from 'chai';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import type {
  KeyRotationProjection,
  RequestSigningProjection,
  RotateKeyRequest,
  ServerEventSigningKey,
  ServerToolSigningKey,
} from '../src/protocol/generated/dtos.js';
import type {
  EventProjection,
  RecoveryCollectionBoundaries,
  RequestBindingContext,
  SnapshotCollectionContext,
  SnapshotPage,
  ToolDecisionProjection,
  ToolDescriptorProjection,
  ToolGrantProjection,
  ToolProposalProjection,
  ToolResultProjection,
} from '../src/protocol/signing.js';

import {
  assembleSnapshotCollection,
  assertIdenticalIdempotentRetry,
  assertSupportedToolInputSchema,
  authorizeToolGrantExecution,
  bodyCanonicalLimits,
  canonicalizeJson,
  canonicalizeJsonText,
  CanonicalJsonError,
  canonicalSseEvent,
  createEventProjection,
  createIdempotentRequestIdentity,
  createKeyRotationProjection,
  createRequestProjection,
  createSnapshotCursor,
  decodeSnapshotCursor,
  digestCanonicalJson,
  EMPTY_BODY_SHA256,
  encodeSnapshotCursor,
  EVENT_ENVELOPE_DOMAIN,
  eventHash,
  type JsonValue,
  KEY_ROTATION_DOMAIN,
  keyThumbprint,
  MAX_RECOVERY_ITEM_BYTES,
  MAX_RECOVERY_PAGE_ITEMS,
  MAX_TOOL_ARGUMENTS_BYTES,
  MAX_TOOL_RESULT_VALUE_BYTES,
  negotiateProtocolLimits,
  parseStrictJson,
  PROTOCOL_CANONICAL_LIMITS,
  ProtocolLimitNegotiationError,
  protocolLimitProfileDigest,
  ProtocolSigningError,
  recoveryItemCanonicalLimits,
  REQUEST_SIGNATURE_DOMAIN,
  resolveServerToolSigningAuthorities,
  selectSnapshotPageItems,
  SERVER_PROTOCOL_LIMITS,
  sha256Bytes,
  type SignedEventEnvelope,
  type SignedToolDecision,
  type SignedToolDescriptor,
  type SignedToolGrant,
  type SignedToolProposal,
  type SignedToolResult,
  signProjection,
  snapshotCollectionBoundary,
  TOOL_DECISION_DOMAIN,
  TOOL_DESCRIPTOR_DOMAIN,
  TOOL_GRANT_DOMAIN,
  TOOL_PROPOSAL_DOMAIN,
  TOOL_RESULT_DOMAIN,
  toolArgumentsCanonicalLimits,
  toolDecisionDigest,
  toolDescriptorDigest,
  toolGrantDigest,
  type ToolLifecycleAuthorities,
  toolProposalDigest,
  toolResultDigest,
  toolResultValueCanonicalLimits,
  validateBoundedCanonicalJson,
  validateServerEventSigningKeys,
  verifyBoundRequest,
  verifyEventEnvelope,
  verifyKeyRotationRequest,
  verifyProjection,
  verifyRecoveredToolResult,
  verifySnapshotCursor,
  verifySnapshotPage,
  verifyToolDecision,
  verifyToolDescriptor,
  verifyToolGrant,
  verifyToolProposal,
  verifyToolResult,
} from '../src/protocol/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = path.join(root, 'protocol', 'schemas');
const require = createRequire(import.meta.url);

type SchemaValidator = ((data: unknown) => boolean) & {errors?: unknown};
interface SchemaCompiler {
  addKeyword(definition: Record<string, unknown>): unknown;
  addSchema(schema: Record<string, unknown>): unknown;
  getSchema(id: string): SchemaValidator | undefined;
}

const Ajv2020 = (require('ajv/dist/2020') as {
  default: new(options: Record<string, unknown>) => SchemaCompiler;
}).default;
const addFormats = (require('ajv-formats') as {
  default: (ajv: SchemaCompiler) => unknown;
}).default;

interface SigningVectors {
  eventChain: {
    eventHash: string;
    payload: Record<string, JsonValue>;
    projection: EventProjection;
    serverSigningKey: ServerEventSigningKey;
    signature: string;
  };
  invalidCanonicalJson: Array<{expectedCode: string; source: string}>;
  jcs: Array<{canonical: string; digest: string; value: unknown}>;
  keyRotation: {
    domain: string;
    negative: string[];
    newPrivateSeed: string;
    newPublicKey: string;
    projection: KeyRotationProjection;
    proof: RotateKeyRequest['newKeyProof'];
    signingInput: string;
  };
  privateSeed: string;
  publicKey: string;
  request: {
    accessToken: string;
    body: Record<string, JsonValue>;
    canonicalProjection: string;
    projection: RequestSigningProjection;
    signature: string;
    signingInput: string;
  };
  snapshotCursor: {
    canonicalCursor: string;
    collectionGenesisDigest: string;
    domain: string;
    negative: string[];
    projection: {
      collection: 'operations';
      collectionDigest: string;
      expiresAt: string;
      limitProfileDigest: string;
      nextOffset: number;
      protocolVersion: '1.0';
      sessionId: string;
      snapshotId: string;
      snapshotVersion: number;
      tenantId: string;
    };
    signature: string;
    token: string;
  };
  toolLifecycle: {
    decision: {digest: string; projection: ToolDecisionProjection; signature: string};
    descriptor: {digest: string; projection: ToolDescriptorProjection; signature: string};
    grant: {digest: string; projection: ToolGrantProjection; signature: string};
    grantPrivateSeed: string;
    proposal: {
      arguments: Record<string, JsonValue>;
      digest: string;
      projection: ToolProposalProjection;
      signature: string;
    };
    proposalPrivateSeed: string;
    result: {digest: string; projection: ToolResultProjection; signature: string};
    serverSigningKeys: ServerToolSigningKey[];
  };
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(root, 'protocol', 'signing-vectors.json'), 'utf8'),
) as SigningVectors;

const keyId = '33333333-3333-4333-8333-333333333333';
const requestTime = Date.parse(vectors.request.projection.timestamp);
const limits = SERVER_PROTOCOL_LIMITS;
const limitProfileDigest = protocolLimitProfileDigest(limits);
const loweredLimitOffer = Object.freeze({
  ...SERVER_PROTOCOL_LIMITS,
  maxArrayItems: 64,
  maxBodyBytes: 524_288,
  maxCanonicalDepth: 24,
  maxCanonicalNodes: 5000,
  maxEventBytes: 131_072,
  maxObjectKeys: 64,
  maxRecoveryItemBytes: 393_216,
  maxRecoveryItemDepth: 22,
  maxRecoveryItemNodes: 4744,
  maxRecoveryPageItems: 8,
  maxRecoveryPageOverheadBytes: 131_072,
  maxRecoveryPageOverheadNodes: 256,
  maxStringBytes: 32_768,
  maxToolArgumentsBytes: 114_688,
  maxToolDescriptors: 8,
  maxToolResultValueBytes: 262_144,
});

function expectSigningError(run: () => unknown, code: string): void {
  try {
    run();
    expect.fail(`expected ProtocolSigningError ${code}`);
  } catch (error) {
    expect(error).to.be.instanceOf(ProtocolSigningError);
    expect((error as ProtocolSigningError).code).to.equal(code);
  }
}

function expectCanonicalError(run: () => unknown, code: string): void {
  try {
    run();
    expect.fail(`expected CanonicalJsonError ${code}`);
  } catch (error) {
    expect(error).to.be.instanceOf(CanonicalJsonError);
    expect((error as CanonicalJsonError).code).to.equal(code);
  }
}

function compileSchemas(): SchemaCompiler {
  const ajv = new Ajv2020({allErrors: true, strict: true});
  ajv.addKeyword({keyword: 'x-max-canonical-bytes', schemaType: 'number'});
  ajv.addKeyword({keyword: 'x-shadow-limit-invariants', schemaType: 'array'});
  ajv.addKeyword({keyword: 'x-shadow-semantic-validator', schemaType: 'string'});
  ajv.addKeyword({keyword: 'x-typescript-exports', schemaType: 'object'});
  addFormats(ajv);
  const names = fs.readdirSync(schemaDirectory).filter((name) => name.endsWith('.json')).sort();
  const schemas = names.map((name) => JSON.parse(
    fs.readFileSync(path.join(schemaDirectory, name), 'utf8'),
  ) as Record<string, unknown>);
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) {
    expect(ajv.getSchema(schema.$id as string), schema.$id as string).to.be.a('function');
    const definitions = schema.$defs as Record<string, unknown> | undefined;
    for (const name of Object.keys(definitions ?? {})) {
      expect(ajv.getSchema(`${schema.$id as string}#/$defs/${name}`), `${schema.$id as string} ${name}`)
        .to.be.a('function');
    }
  }

  return ajv;
}

function validator(ajv: SchemaCompiler, schema: string, definition: string): SchemaValidator {
  const result = ajv.getSchema(
    `https://shadow-auditor.dev/protocol/1.0/schemas/${schema}.schema.json#/$defs/${definition}`,
  );
  expect(result, `${schema}#${definition}`).to.be.a('function');
  if (!result) throw new Error(`missing validator for ${schema}#${definition}`);
  return result;
}

const eventEnvelopeSchema = validator(compileSchemas(), 'events', 'EventEnvelope');

function authorization(signature: string, authorizationKeyId = keyId) {
  return {algorithm: 'Ed25519' as const, keyId: authorizationKeyId, signature};
}

function toolAuthorities(): ToolLifecycleAuthorities {
  const deviceAuthority = {expectedKeyId: keyId, publicKey: vectors.publicKey};
  const serverAuthorities = resolveServerToolSigningAuthorities(
    vectors.toolLifecycle.serverSigningKeys,
  );
  return {
    decision: deviceAuthority,
    descriptor: deviceAuthority,
    ...serverAuthorities,
    result: deviceAuthority,
  };
}

function eventAuthorization(signature: string) {
  return {
    algorithm: 'Ed25519' as const,
    keyId: vectors.eventChain.serverSigningKey.keyId,
    signature,
  };
}

function requestContext(overrides: Partial<RequestBindingContext> = {}): RequestBindingContext {
  const projection = vectors.request.projection;
  return {
    accessToken: vectors.request.accessToken,
    body: vectors.request.body,
    bodyMediaType: 'application/json' as const,
    deviceId: projection.deviceId,
    idempotencyKey: projection.idempotencyKey as string,
    keyId: projection.keyId,
    limits,
    method: projection.method,
    nonce: projection.nonce,
    path: projection.canonicalPath,
    publicKey: vectors.publicKey,
    query: projection.canonicalQuery,
    requestId: projection.requestId,
    sessionId: projection.sessionId as string,
    tenantId: projection.tenantId,
    timestamp: projection.timestamp,
    tokenClaims: {
      cnf: {jkt: keyThumbprint(vectors.publicKey)},
      deviceId: projection.deviceId,
      expiresAt: '2026-01-02T04:00:00.000Z',
      issuedAt: '2026-01-02T03:00:00.000Z',
      keyId: projection.keyId,
      tenantId: projection.tenantId,
    },
    ...overrides,
  };
}

function requestVerification(
  overrides: Parameters<typeof verifyBoundRequest>[3] = {},
): Parameters<typeof verifyBoundRequest>[3] {
  return {
    consumeNonce: () => true,
    isKeyRevoked: () => false,
    now: requestTime,
    ...overrides,
  };
}

function toolRecords(): {
  decision: SignedToolDecision;
  descriptor: SignedToolDescriptor;
  grant: SignedToolGrant;
  proposal: SignedToolProposal;
  result: SignedToolResult;
} {
  const lifecycle = vectors.toolLifecycle;
  return {
    decision: {
      authorization: authorization(lifecycle.decision.signature),
      decisionDigest: lifecycle.decision.digest,
      projection: structuredClone(lifecycle.decision.projection),
    },
    descriptor: {
      authorization: authorization(lifecycle.descriptor.signature),
      descriptorDigest: lifecycle.descriptor.digest,
      projection: structuredClone(lifecycle.descriptor.projection),
    },
    grant: {
      authorization: authorization(
        lifecycle.grant.signature,
        toolAuthorities().grant.expectedKeyId,
      ),
      grantDigest: lifecycle.grant.digest,
      projection: structuredClone(lifecycle.grant.projection),
    },
    proposal: {
      arguments: structuredClone(lifecycle.proposal.arguments),
      authorization: authorization(
        lifecycle.proposal.signature,
        toolAuthorities().proposal.expectedKeyId,
      ),
      projection: structuredClone(lifecycle.proposal.projection),
      proposalDigest: lifecycle.proposal.digest,
    },
    result: {
      authorization: authorization(lifecycle.result.signature),
      projection: structuredClone(lifecycle.result.projection),
      resultDigest: lifecycle.result.digest,
    },
  };
}

function eventEnvelope(): SignedEventEnvelope {
  return {
    ...structuredClone(vectors.eventChain.projection),
    authorization: eventAuthorization(vectors.eventChain.signature),
    eventHash: vectors.eventChain.eventHash,
    payload: structuredClone(vectors.eventChain.payload) as SignedEventEnvelope['payload'],
  };
}

function eventVerification(
  expectedHead?: {cursor: number; eventHash: null | string},
  expectedSessionId = vectors.eventChain.projection.sessionId,
  expectedTenantId = vectors.eventChain.projection.tenantId,
) {
  return {
    expectedHead: expectedHead ?? {cursor: 0, eventHash: null},
    expectedSessionId,
    expectedTenantId,
    limits,
    serverSigningKeys: [structuredClone(vectors.eventChain.serverSigningKey)],
    validateEnvelope: (envelope: SignedEventEnvelope) => eventEnvelopeSchema(envelope),
  };
}

function indexedUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function exactCanonicalSizeObject(
  targetBytes: number,
  maxChunkBytes = limits.maxStringBytes,
): {chunks: string[]} {
  const value = {chunks: [] as string[]};
  while (true) {
    const currentBytes = Buffer.byteLength(canonicalizeJson(value), 'utf8');
    const entryOverhead = value.chunks.length === 0 ? 2 : 3;
    const remaining = targetBytes - currentBytes - entryOverhead;
    if (remaining <= maxChunkBytes) {
      if (remaining < 0) throw new Error(`cannot construct ${targetBytes}-byte canonical value`);
      value.chunks.push('x'.repeat(remaining));
      break;
    }

    value.chunks.push('x'.repeat(maxChunkBytes));
  }

  if (Buffer.byteLength(canonicalizeJson(value), 'utf8') !== targetBytes) {
    throw new Error(`failed to construct ${targetBytes}-byte canonical value`);
  }

  return value;
}

function recoveryOperation(index: number) {
  return {
    operation: {
      deviceId: vectors.request.projection.deviceId,
      idempotencyKey: indexedUuid(index + 0x1_00_00),
      kind: 'session.control',
      outcome: {
        bodyDigest: EMPTY_BODY_SHA256,
        committedAt: '2026-01-02T03:04:10.000Z',
        httpStatus: 204,
        mediaType: 'none',
        replayToken: 'Z3JhbnQtb25lLXVzZS0wMQ',
      },
      protocolVersion: '1.0',
      requestDigest: createIdempotentRequestIdentity(vectors.request.projection).requestDigest,
      requestId: indexedUuid(index),
      resourceId: null,
      status: 'committed',
      tenantId: vectors.request.projection.tenantId,
    },
    sessionId: vectors.request.projection.sessionId as string,
  };
}

function recoveryBoundaries(
  operations: readonly unknown[],
  effectiveLimits = limits,
): RecoveryCollectionBoundaries {
  return {
    activeGrants: snapshotCollectionBoundary('activeGrants', [], effectiveLimits),
    decisions: snapshotCollectionBoundary('decisions', [], effectiveLimits),
    grants: snapshotCollectionBoundary('grants', [], effectiveLimits),
    operations: snapshotCollectionBoundary('operations', operations, effectiveLimits),
    pendingProposals: snapshotCollectionBoundary('pendingProposals', [], effectiveLimits),
    proposals: snapshotCollectionBoundary('proposals', [], effectiveLimits),
    results: snapshotCollectionBoundary('results', [], effectiveLimits),
  };
}

function snapshotAuthority() {
  return {
    expectedKeyId: vectors.eventChain.serverSigningKey.keyId,
    publicKey: vectors.eventChain.serverSigningKey.publicKey,
  };
}

function recoveryPages(
  operations: readonly unknown[],
  snapshotId = vectors.snapshotCursor.projection.snapshotId,
  snapshotCreatedAt = '2026-01-02T03:04:08.000Z',
  snapshotExpiresAt = vectors.snapshotCursor.projection.expiresAt,
  effectiveLimits = limits,
): SnapshotPage[] {
  const boundaries = recoveryBoundaries(operations, effectiveLimits);
  const profileDigest = protocolLimitProfileDigest(effectiveLimits);
  const pages: SnapshotPage[] = [];
  for (
    let pageStart = 0;
    pageStart < operations.length || pageStart === 0;
    pageStart += effectiveLimits.maxRecoveryPageItems
  ) {
    const items = operations.slice(pageStart, pageStart + effectiveLimits.maxRecoveryPageItems);
    const nextOffset = pageStart + items.length;
    const nextCursor = nextOffset < operations.length
      ? encodeSnapshotCursor(createSnapshotCursor(
        {
          collection: 'operations',
          collectionDigest: boundaries.operations.collectionDigest,
          expiresAt: snapshotExpiresAt,
          limitProfileDigest: profileDigest,
          nextOffset,
          protocolVersion: '1.0',
          sessionId: vectors.request.projection.sessionId as string,
          snapshotId,
          snapshotVersion: 1,
          tenantId: vectors.request.projection.tenantId,
        },
        vectors.eventChain.serverSigningKey.keyId,
        vectors.privateSeed,
        effectiveLimits,
      ), effectiveLimits)
      : null;
    pages.push({
      collection: 'operations',
      collectionBoundaries: boundaries,
      createdAt: '2026-01-02T03:04:05.000Z',
      eventHead: {cursor: 1, eventHash: vectors.eventChain.eventHash},
      items,
      limitProfileDigest: profileDigest,
      nextCursor,
      pageStart,
      protocolVersion: '1.0',
      sessionId: vectors.request.projection.sessionId as string,
      snapshotCreatedAt,
      snapshotExpiresAt,
      snapshotId,
      snapshotVersion: 1,
      state: 'awaiting-result',
      tenantId: vectors.request.projection.tenantId,
      updatedAt: '2026-01-02T03:04:10.000Z',
    });
    if (operations.length === 0) break;
  }

  return pages;
}

function recoveryPage(
  collection: SnapshotPage['collection'],
  items: readonly unknown[],
  collectionBoundaries: RecoveryCollectionBoundaries,
  effectiveLimits = limits,
): SnapshotPage {
  return {
    collection,
    collectionBoundaries,
    createdAt: '2026-01-02T03:04:05.000Z',
    eventHead: {cursor: 1, eventHash: vectors.eventChain.eventHash},
    items,
    limitProfileDigest: protocolLimitProfileDigest(effectiveLimits),
    nextCursor: null,
    pageStart: 0,
    protocolVersion: '1.0',
    sessionId: vectors.request.projection.sessionId as string,
    snapshotCreatedAt: '2026-01-02T03:04:08.000Z',
    snapshotExpiresAt: '2026-01-02T03:24:08.000Z',
    snapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    snapshotVersion: 1,
    state: 'completed',
    tenantId: vectors.request.projection.tenantId,
    updatedAt: '2026-01-02T03:04:10.000Z',
  };
}

function snapshotContext(
  page: SnapshotPage,
  effectiveLimits = limits,
): SnapshotCollectionContext {
  return {
    collection: page.collection,
    collectionBoundaries: page.collectionBoundaries,
    createdAt: page.createdAt,
    eventHead: page.eventHead,
    limitProfileDigest: page.limitProfileDigest,
    limits: effectiveLimits,
    protocolVersion: page.protocolVersion,
    sessionId: page.sessionId,
    snapshotCreatedAt: page.snapshotCreatedAt,
    snapshotExpiresAt: page.snapshotExpiresAt,
    snapshotId: page.snapshotId,
    snapshotVersion: page.snapshotVersion,
    state: page.state,
    tenantId: page.tenantId,
    updatedAt: page.updatedAt,
  };
}

describe('Shadow Auditor protocol 1.0 contract', () => {
  describe('strict bounded canonical JSON', () => {
    it('matches every canonical JSON golden vector and distinguishes JSON from raw bytes', () => {
      for (const vector of vectors.jcs) {
        expect(canonicalizeJson(vector.value)).to.equal(vector.canonical);
        expect(digestCanonicalJson(vector.value)).to.equal(vector.digest);
      }

      expect(digestCanonicalJson('snowman ☃')).not.to.equal(
        sha256Bytes(Buffer.from('snowman ☃', 'utf8')),
      );
      expect(EMPTY_BODY_SHA256).to.equal(sha256Bytes(new Uint8Array()));
      expect(canonicalizeJsonText(' { "z": 2, "a": [true, null] } '))
        .to.equal('{"a":[true,null],"z":2}');
    });

    it('rejects every invalid canonical JSON golden vector at the parse boundary', () => {
      for (const vector of vectors.invalidCanonicalJson) {
        expectCanonicalError(() => parseStrictJson(vector.source), vector.expectedCode);
      }
    });

    it('rejects unsupported values, sparse data, cycles, accessors, and invalid Unicode', () => {
      const sparse = [1, 2];
      delete sparse[0];
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const accessor = Object.defineProperty({}, 'secret', {enumerable: true, get: () => 1});
      let arrayAccessorReads = 0;
      const arrayAccessor = Object.defineProperty([1], 0, {
        enumerable: true,
        get() {
          arrayAccessorReads++;
          return arrayAccessorReads === 1 ? 1 : () => 1;
        },
      });
      class Executable {
        value = 1;
      }

      for (const value of [undefined, () => 1, Symbol('x'), 1n]) {
        expectCanonicalError(() => canonicalizeJson(value), 'unsupported_type');
      }

      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
        expectCanonicalError(() => canonicalizeJson(value), 'invalid_number');
      }

      expectCanonicalError(() => canonicalizeJson(Number.MAX_SAFE_INTEGER + 1), 'unsafe_integer');
      expectCanonicalError(() => canonicalizeJson(sparse), 'sparse_array');
      expectCanonicalError(() => canonicalizeJson(cyclic), 'cyclic_value');
      expectCanonicalError(() => canonicalizeJson(accessor), 'unsupported_property');
      expectCanonicalError(() => canonicalizeJson(arrayAccessor), 'unsupported_property');
      expect(arrayAccessorReads).to.equal(0);
      expectCanonicalError(() => canonicalizeJson(new Executable()), 'unsupported_object');
      expectCanonicalError(() => canonicalizeJson('\uD800'), 'invalid_unicode');
    });

    it('enforces depth, node, key, string, array, and payload limits before signing', () => {
      const limits = {...PROTOCOL_CANONICAL_LIMITS};
      expectCanonicalError(
        () => canonicalizeJson([[[0]]], {...limits, maxDepth: 2}),
        'too_deep',
      );
      expectCanonicalError(
        () => canonicalizeJson({a: 1, b: 2}, {...limits, maxNodes: 4}),
        'too_many_nodes',
      );
      expectCanonicalError(
        () => canonicalizeJson({a: 1, b: 2}, {...limits, maxObjectKeys: 1}),
        'object_too_large',
      );
      expectCanonicalError(
        () => canonicalizeJson('ab', {...limits, maxStringBytes: 1}),
        'string_too_large',
      );
      expectCanonicalError(
        () => canonicalizeJson([1, 2], {...limits, maxArrayLength: 1}),
        'array_too_large',
      );
      expectCanonicalError(
        () => canonicalizeJson({a: '1234'}, {...limits, maxPayloadBytes: 4}),
        'payload_too_large',
      );
      expectCanonicalError(
        () => parseStrictJson('{"a":1,"b":2}', {...limits, maxObjectKeys: 1}),
        'object_too_large',
      );
    });
  });

  describe('negotiated limit profiles', () => {
    it('computes symmetric minima and rejects inconsistent profiles before use', () => {
      const clientFirst = negotiateProtocolLimits(loweredLimitOffer, SERVER_PROTOCOL_LIMITS);
      const serverFirst = negotiateProtocolLimits(SERVER_PROTOCOL_LIMITS, loweredLimitOffer);
      expect(clientFirst).to.deep.equal(loweredLimitOffer);
      expect(serverFirst).to.deep.equal(clientFirst);
      expect(protocolLimitProfileDigest(serverFirst)).to.equal(
        protocolLimitProfileDigest(clientFirst),
      );
      const largerCompatibleOffer = {
        ...SERVER_PROTOCOL_LIMITS,
        maxToolArgumentsBytes: 524_288,
      };
      expect(negotiateProtocolLimits(largerCompatibleOffer, SERVER_PROTOCOL_LIMITS))
        .to.deep.equal(SERVER_PROTOCOL_LIMITS);
      expect(negotiateProtocolLimits(SERVER_PROTOCOL_LIMITS, largerCompatibleOffer))
        .to.deep.equal(SERVER_PROTOCOL_LIMITS);

      for (const incompatible of [
        {...loweredLimitOffer, maxBodyBytes: loweredLimitOffer.maxBodyBytes - 1},
        {...loweredLimitOffer, maxCanonicalNodes: loweredLimitOffer.maxCanonicalNodes - 1},
        {...loweredLimitOffer, maxCanonicalDepth: loweredLimitOffer.maxCanonicalDepth - 1},
        {...loweredLimitOffer, maxEventBytes: loweredLimitOffer.maxToolArgumentsBytes + 16_383},
        {...loweredLimitOffer, maxRecoveryPageItems: loweredLimitOffer.maxArrayItems + 1},
        {...loweredLimitOffer, maxStringBytes: 127},
      ]) {
        expect(() => negotiateProtocolLimits(SERVER_PROTOCOL_LIMITS, incompatible))
          .to.throw(ProtocolLimitNegotiationError)
          .with.property('code', 'incompatible_limit_profile');
      }
    });

    it('pins a compatible lowered profile across acceptance and paginated recovery', () => {
      const effective = negotiateProtocolLimits(SERVER_PROTOCOL_LIMITS, loweredLimitOffer);
      const maximumArguments = exactCanonicalSizeObject(
        effective.maxToolArgumentsBytes,
        effective.maxStringBytes,
      );
      expect(validateBoundedCanonicalJson(
        maximumArguments,
        toolArgumentsCanonicalLimits(effective),
      ).payloadBytes).to.equal(effective.maxToolArgumentsBytes);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(
          exactCanonicalSizeObject(
            effective.maxToolArgumentsBytes + 1,
            effective.maxStringBytes,
          ),
          toolArgumentsCanonicalLimits(effective),
        ),
        'payload_too_large',
      );

      const base = toolRecords();
      expectSigningError(
        () => assertSupportedToolInputSchema(
          {
            maxLength: effective.maxStringBytes + 1,
            minLength: effective.maxStringBytes + 1,
            type: 'string',
          },
          effective,
        ),
        'invalid_tool_schema',
      );
      const inputSchema: JsonValue = {
        additionalProperties: false,
        maxProperties: 1,
        properties: {
          chunks: {
            items: {maxLength: effective.maxStringBytes, type: 'string'},
            maxItems: effective.maxArrayItems,
            type: 'array',
          },
        },
        required: ['chunks'],
        type: 'object',
      };
      const descriptorProjection: ToolDescriptorProjection = {
        ...base.descriptor.projection,
        inputSchema,
        schemaDigest: digestCanonicalJson(inputSchema, bodyCanonicalLimits(effective)),
      };
      const descriptor: SignedToolDescriptor = {
        authorization: authorization(
          signProjection(
            TOOL_DESCRIPTOR_DOMAIN,
            descriptorProjection,
            vectors.privateSeed,
            effective,
          ),
        ),
        descriptorDigest: toolDescriptorDigest(descriptorProjection, effective),
        projection: descriptorProjection,
      };
      const createProposal = (
        argumentsValue: Record<string, JsonValue>,
        proposalId: string,
      ): SignedToolProposal => {
        const projection: ToolProposalProjection = {
          ...base.proposal.projection,
          argumentsDigest: digestCanonicalJson(argumentsValue),
          descriptorDigest: descriptor.descriptorDigest,
          proposalId,
        };
        return {
          arguments: argumentsValue,
          authorization: authorization(
            signProjection(
              TOOL_PROPOSAL_DOMAIN,
              projection,
              vectors.toolLifecycle.proposalPrivateSeed,
              effective,
            ),
            toolAuthorities().proposal.expectedKeyId,
          ),
          projection,
          proposalDigest: toolProposalDigest(projection, effective),
        };
      };

      const proposal = createProposal(maximumArguments, indexedUuid(0x20));
      verifyToolProposal(proposal, descriptor, toolAuthorities(), effective);
      const oversizedProposal = createProposal(
        exactCanonicalSizeObject(
          effective.maxToolArgumentsBytes + 1,
          effective.maxStringBytes,
        ),
        indexedUuid(0x21),
      );
      expectCanonicalError(
        () => verifyToolProposal(
          oversizedProposal,
          descriptor,
          toolAuthorities(),
          effective,
        ),
        'payload_too_large',
      );

      const maximumOutput = exactCanonicalSizeObject(
        effective.maxToolResultValueBytes,
        effective.maxStringBytes,
      );
      const resultProjection: ToolResultProjection = {
        ...base.result.projection,
        outputDigest: digestCanonicalJson(
          maximumOutput,
          toolResultValueCanonicalLimits(effective),
        ),
      };
      const result: SignedToolResult = {
        authorization: authorization(
          signProjection(
            TOOL_RESULT_DOMAIN,
            resultProjection,
            vectors.privateSeed,
            effective,
          ),
        ),
        projection: resultProjection,
        resultDigest: toolResultDigest(resultProjection, effective),
      };
      verifyToolResult(
        result,
        base.proposal,
        base.decision,
        base.grant,
        toolAuthorities(),
        {limits: effective, output: maximumOutput},
      );
      const oversizedOutput = exactCanonicalSizeObject(
        effective.maxToolResultValueBytes + 1,
        effective.maxStringBytes,
      );
      expectCanonicalError(
        () => verifyToolResult(
          {
            ...result,
            projection: {
              ...resultProjection,
              outputDigest: digestCanonicalJson(oversizedOutput),
            },
          },
          base.proposal,
          base.decision,
          base.grant,
          toolAuthorities(),
          {limits: effective, output: oversizedOutput},
        ),
        'payload_too_large',
      );

      const operations = Array.from({length: 17}, (_, index) => recoveryOperation(index));
      const pages = recoveryPages(
        operations,
        vectors.snapshotCursor.projection.snapshotId,
        '2026-01-02T03:04:08.000Z',
        vectors.snapshotCursor.projection.expiresAt,
        effective,
      );
      expect(pages).to.have.length(3);
      for (const page of pages) {
        const validation = validateBoundedCanonicalJson(page, bodyCanonicalLimits(effective));
        expect(validation.payloadBytes).to.be.at.most(effective.maxBodyBytes);
        expect(validation.nodeCount).to.be.at.most(effective.maxCanonicalNodes);
        expect(page.items.length).to.be.within(1, effective.maxRecoveryPageItems);
        for (const item of page.items) {
          validateBoundedCanonicalJson(item, recoveryItemCanonicalLimits(effective));
        }
      }

      const now = Date.parse('2026-01-02T03:05:00.000Z');
      expect(assembleSnapshotCollection(
        pages,
        snapshotContext(pages[0], effective),
        snapshotAuthority(),
        now,
      )).to.deep.equal(operations);

      const firstCursor = decodeSnapshotCursor(
        pages[0].nextCursor as string,
        effective,
      );
      expectSigningError(
        () => verifySnapshotCursor(
          firstCursor,
          {
            ...firstCursor.projection,
            expectedOffset: firstCursor.projection.nextOffset,
            limits: SERVER_PROTOCOL_LIMITS,
            snapshotExpiresAt: firstCursor.projection.expiresAt,
          },
          snapshotAuthority(),
          now,
        ),
        'incompatible_limit_profile',
      );

      const restarted = recoveryPages(
        operations,
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        '2026-01-02T03:24:08.000Z',
        '2026-01-02T03:44:08.000Z',
        effective,
      );
      expect(assembleSnapshotCollection(
        restarted,
        snapshotContext(restarted[0], effective),
        snapshotAuthority(),
        Date.parse('2026-01-02T03:25:00.000Z'),
      )).to.deep.equal(operations);

      const lineageBoundaries = {
        ...recoveryBoundaries([], effective),
        decisions: snapshotCollectionBoundary('decisions', [base.decision], effective),
        grants: snapshotCollectionBoundary('grants', [base.grant], effective),
        proposals: snapshotCollectionBoundary('proposals', [base.proposal], effective),
        results: snapshotCollectionBoundary('results', [base.result], effective),
      };
      const lineagePages = {
        decisions: recoveryPage('decisions', [base.decision], lineageBoundaries, effective),
        grants: recoveryPage('grants', [base.grant], lineageBoundaries, effective),
        proposals: recoveryPage('proposals', [base.proposal], lineageBoundaries, effective),
        results: recoveryPage('results', [base.result], lineageBoundaries, effective),
      };
      const recoveredCollections = {
        decisions: assembleSnapshotCollection(
          [lineagePages.decisions],
          snapshotContext(lineagePages.decisions, effective),
          snapshotAuthority(),
          now,
        ) as readonly SignedToolDecision[],
        grants: assembleSnapshotCollection(
          [lineagePages.grants],
          snapshotContext(lineagePages.grants, effective),
          snapshotAuthority(),
          now,
        ) as readonly SignedToolGrant[],
        proposals: assembleSnapshotCollection(
          [lineagePages.proposals],
          snapshotContext(lineagePages.proposals, effective),
          snapshotAuthority(),
          now,
        ) as readonly SignedToolProposal[],
      };
      const [recoveredResult] = assembleSnapshotCollection(
        [lineagePages.results],
        snapshotContext(lineagePages.results, effective),
        snapshotAuthority(),
        now,
      ) as readonly SignedToolResult[];
      verifyRecoveredToolResult(
        recoveredResult,
        recoveredCollections,
        toolAuthorities(),
        effective,
      );
    });
  });

  describe('request binding, authentication, and idempotency', () => {
    it('reproduces and verifies the positive detached request signing vector', () => {
      expect(canonicalizeJson(vectors.request.projection)).to.equal(
        vectors.request.canonicalProjection,
      );
      expect(`${REQUEST_SIGNATURE_DOMAIN}\n${vectors.request.canonicalProjection}`)
        .to.equal(vectors.request.signingInput);
      expect(signProjection(
        REQUEST_SIGNATURE_DOMAIN,
        vectors.request.projection,
        vectors.privateSeed,
      )).to.equal(vectors.request.signature);
      expect(verifyProjection(
        REQUEST_SIGNATURE_DOMAIN,
        vectors.request.projection,
        vectors.request.signature,
        vectors.publicKey,
      )).to.equal(true);
      expect(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification(),
      )).not.to.throw();
    });

    it('fails closed on body, path, query, time, nonce, idempotency, token, and key tampering', () => {
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext({
          body: {...vectors.request.body, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
        }),
        requestVerification(),
      ), 'binding_mismatch');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext({path: '/v1/sessions%2Fescape'}),
        requestVerification(),
      ), 'ambiguous_path');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext({query: 'z=last&a=first'}),
        requestVerification(),
      ), 'noncanonical_url');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification({now: requestTime + 300_001}),
      ), 'stale_request');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification({consumeNonce: () => false}),
      ), 'nonce_reuse');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext({idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),
        requestVerification(),
      ), 'binding_mismatch');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext({
          tokenClaims: {
            ...requestContext().tokenClaims!,
            cnf: {jkt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'},
          },
        }),
        requestVerification(),
      ), 'binding_mismatch');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification({isKeyRevoked: () => true}),
      ), 'revoked_key');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature.slice(1),
        requestContext(),
        requestVerification(),
      ), 'invalid_base64url');
    });

    it('uses atomic nonce consumption for new authority and permits only exact committed replay', () => {
      const nonces = new Set<string>();
      const consumeNonce = (_tenantId: string, _deviceId: string, nonce: string) => {
        if (nonces.has(nonce)) return false;
        nonces.add(nonce);
        return true;
      };

      verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification({consumeNonce}),
      );
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification({consumeNonce}),
      ), 'nonce_reuse');

      const committed = createIdempotentRequestIdentity(vectors.request.projection);
      expect(() => assertIdenticalIdempotentRetry(committed, {...committed})).not.to.throw();
      expect(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        requestVerification({
          committedOperation: committed,
          now: requestTime + 86_400_000,
        }),
      )).not.to.throw();

      const altered = createRequestProjection({
        ...requestContext(),
        nonce: 'QUJDREVGR0hJSktMTU5PUA',
      });
      expectSigningError(
        () => assertIdenticalIdempotentRetry(
          committed,
          createIdempotentRequestIdentity(altered),
        ),
        'idempotency_conflict',
      );
    });

    it('requires revocation and nonce storage and permits expired tokens only for fresh refresh', () => {
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        {consumeNonce: () => true, now: requestTime},
      ), 'revocation_store_unavailable');
      expectSigningError(() => verifyBoundRequest(
        vectors.request.projection,
        vectors.request.signature,
        requestContext(),
        {isKeyRevoked: () => false, now: requestTime},
      ), 'nonce_store_unavailable');

      const refreshBody = {
        deviceId: vectors.request.projection.deviceId,
        keyId,
        protocolVersion: '1.0',
        refreshToken: 'r'.repeat(32),
        tenantId: vectors.request.projection.tenantId,
      } as const;
      const expiredClaims = {
        ...requestContext().tokenClaims!,
        expiresAt: '2026-01-02T03:04:04.000Z',
      };
      const refreshContext = requestContext({
        body: refreshBody,
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
        method: 'POST',
        path: '/v1/auth/refresh',
        query: '',
        sessionId: undefined,
        tokenClaims: expiredClaims,
      });
      const refreshProjection = createRequestProjection(refreshContext);
      const refreshSignature = signProjection(
        REQUEST_SIGNATURE_DOMAIN,
        refreshProjection,
        vectors.privateSeed,
      );
      expect(() => verifyBoundRequest(
        refreshProjection,
        refreshSignature,
        refreshContext,
        requestVerification(),
      )).not.to.throw();

      const nonRefreshContext = {...refreshContext, method: 'GET'};
      const nonRefreshProjection = createRequestProjection(nonRefreshContext);
      expectSigningError(() => verifyBoundRequest(
        nonRefreshProjection,
        signProjection(REQUEST_SIGNATURE_DOMAIN, nonRefreshProjection, vectors.privateSeed),
        nonRefreshContext,
        requestVerification(),
      ), 'expired_token');

      const unauthenticatedContext = requestContext({
        accessToken: undefined,
        tokenClaims: undefined,
      });
      const unauthenticatedProjection = createRequestProjection(unauthenticatedContext);
      expectSigningError(() => verifyBoundRequest(
        unauthenticatedProjection,
        signProjection(REQUEST_SIGNATURE_DOMAIN, unauthenticatedProjection, vectors.privateSeed),
        unauthenticatedContext,
        requestVerification(),
      ), 'missing_access_token');

      const enrollmentContext = requestContext({
        accessToken: undefined,
        body: {
          bootstrapToken: 'b'.repeat(32),
          clientCapabilities: {
            compression: ['identity'],
            limits: PROTOCOL_CANONICAL_LIMITS,
            optionalFeatures: [],
            requiredFeatures: ['bound-ed25519-auth'],
            supportedVersions: ['1.0'],
          },
          deviceId: vectors.request.projection.deviceId,
          deviceLabel: 'workstation',
          keyId,
          keyThumbprint: keyThumbprint(vectors.publicKey),
          protocolVersion: '1.0',
          publicKey: vectors.publicKey,
          tenantId: vectors.request.projection.tenantId,
        },
        idempotencyKey: '88888888-8888-4888-8888-888888888888',
        method: 'POST',
        path: '/v1/enrollments',
        query: '',
        sessionId: undefined,
        tokenClaims: undefined,
      });
      const enrollmentProjection = createRequestProjection(enrollmentContext);
      expect(() => verifyBoundRequest(
        enrollmentProjection,
        signProjection(REQUEST_SIGNATURE_DOMAIN, enrollmentProjection, vectors.privateSeed),
        enrollmentContext,
        requestVerification(),
      )).not.to.throw();
      const mismatchedEnrollmentContext = requestContext({
        ...enrollmentContext,
        body: {
          ...(enrollmentContext.body as Record<string, JsonValue>),
          keyThumbprint: keyThumbprint(vectors.keyRotation.projection.newPublicKey),
          publicKey: vectors.keyRotation.projection.newPublicKey,
        },
      });
      const mismatchedEnrollmentProjection = createRequestProjection(mismatchedEnrollmentContext);
      expectSigningError(() => verifyBoundRequest(
        mismatchedEnrollmentProjection,
        signProjection(
          REQUEST_SIGNATURE_DOMAIN,
          mismatchedEnrollmentProjection,
          vectors.privateSeed,
        ),
        mismatchedEnrollmentContext,
        requestVerification(),
      ), 'binding_mismatch');
      const alteredThumbprintContext = requestContext({
        ...enrollmentContext,
        body: {
          ...(enrollmentContext.body as Record<string, JsonValue>),
          keyThumbprint: keyThumbprint(vectors.keyRotation.projection.newPublicKey),
        },
      });
      const alteredThumbprintProjection = createRequestProjection(alteredThumbprintContext);
      expectSigningError(() => verifyBoundRequest(
        alteredThumbprintProjection,
        signProjection(
          REQUEST_SIGNATURE_DOMAIN,
          alteredThumbprintProjection,
          vectors.privateSeed,
        ),
        alteredThumbprintContext,
        requestVerification(),
      ), 'binding_mismatch');
      const incompleteEnrollmentContext = requestContext({
        ...enrollmentContext,
        body: {bootstrapToken: 'b'.repeat(32)},
      });
      const incompleteEnrollmentProjection = createRequestProjection(incompleteEnrollmentContext);
      expectSigningError(() => verifyBoundRequest(
        incompleteEnrollmentProjection,
        signProjection(
          REQUEST_SIGNATURE_DOMAIN,
          incompleteEnrollmentProjection,
          vectors.privateSeed,
        ),
        incompleteEnrollmentContext,
        requestVerification(),
      ), 'invalid_request');
      const credentialedEnrollmentContext = requestContext({
        body: enrollmentContext.body,
        idempotencyKey: enrollmentContext.idempotencyKey,
        method: 'POST',
        path: '/v1/enrollments',
        query: '',
        sessionId: undefined,
      });
      const credentialedEnrollmentProjection = createRequestProjection(credentialedEnrollmentContext);
      expectSigningError(() => verifyBoundRequest(
        credentialedEnrollmentProjection,
        signProjection(
          REQUEST_SIGNATURE_DOMAIN,
          credentialedEnrollmentProjection,
          vectors.privateSeed,
        ),
        credentialedEnrollmentContext,
        requestVerification(),
      ), 'unexpected_access_token');
    });

    it('verifies the non-circular new-key rotation proof and every identity binding', () => {
      const request: RotateKeyRequest = {
        newKeyProof: structuredClone(vectors.keyRotation.proof),
        projection: structuredClone(vectors.keyRotation.projection),
      };
      expect(vectors.keyRotation.domain).to.equal(KEY_ROTATION_DOMAIN);
      expect(createKeyRotationProjection({
        currentKeyId: request.projection.currentKeyId,
        deviceId: request.projection.deviceId,
        newKeyId: request.projection.newKeyId,
        newKeyThumbprint: request.projection.newKeyThumbprint,
        newPublicKey: request.projection.newPublicKey,
        tenantId: request.projection.tenantId,
      })).to.deep.equal(request.projection);
      expect(signProjection(
        KEY_ROTATION_DOMAIN,
        request.projection,
        vectors.keyRotation.newPrivateSeed,
      )).to.equal(request.newKeyProof.signature);
      expect(() => verifyKeyRotationRequest(request, {
        currentKeyId: keyId,
        deviceId: request.projection.deviceId,
        tenantId: request.projection.tenantId,
      })).not.to.throw();

      const rotationContext = requestContext({
        body: request as unknown as JsonValue,
        idempotencyKey: '99999999-9999-4999-8999-999999999999',
        method: 'POST',
        path: '/v1/keys/rotate',
        query: '',
        sessionId: undefined,
      });
      const rotationProjection = createRequestProjection(rotationContext);
      const rotationSignature = signProjection(
        REQUEST_SIGNATURE_DOMAIN,
        rotationProjection,
        vectors.privateSeed,
      );
      const rotationIdentity = {
        ...createIdempotentRequestIdentity(rotationProjection),
        kind: 'key.rotate' as const,
      };
      expectSigningError(() => verifyBoundRequest(
        rotationProjection,
        rotationSignature,
        rotationContext,
        {
          committedOperation: rotationIdentity,
          now: requestTime + 86_400_000,
        },
      ), 'revocation_store_unavailable');
      expect(() => verifyBoundRequest(
        rotationProjection,
        rotationSignature,
        rotationContext,
        {
          committedOperation: rotationIdentity,
          isKeyRevoked: () => true,
          now: requestTime + 86_400_000,
        },
      )).not.to.throw();
      expectSigningError(() => verifyBoundRequest(
        rotationProjection,
        rotationSignature,
        rotationContext,
        {
          committedOperation: {...rotationIdentity, kind: 'session.create'},
          isKeyRevoked: () => true,
          now: requestTime,
        },
      ), 'revoked_key');

      {
        const altered: RotateKeyRequest = {
          ...request,
          newKeyProof: {
            ...request.newKeyProof,
            keyId: '15151515-1515-4151-8151-151515151515',
          },
        };
        expectSigningError(() => verifyKeyRotationRequest(altered, {
          currentKeyId: keyId,
          deviceId: request.projection.deviceId,
          tenantId: request.projection.tenantId,
        }), 'binding_mismatch');
      }

      {
        const altered: RotateKeyRequest = {
          ...request,
          projection: {...request.projection, newKeyThumbprint: 'A'.repeat(43)},
        };
        expectSigningError(() => verifyKeyRotationRequest(altered, {
          currentKeyId: keyId,
          deviceId: request.projection.deviceId,
          tenantId: request.projection.tenantId,
        }), 'binding_mismatch');
      }

      {
        const altered: RotateKeyRequest = {
          ...request,
          newKeyProof: {
            ...request.newKeyProof,
            signature: request.newKeyProof.signature.slice(1),
          },
        };
        expectSigningError(() => verifyKeyRotationRequest(altered, {
          currentKeyId: keyId,
          deviceId: request.projection.deviceId,
          tenantId: request.projection.tenantId,
        }), 'invalid_base64url');
      }
    });

    it('replays only an exact committed self-revocation after the signing key is revoked', () => {
      const revokeBody = {
        deviceId: vectors.request.projection.deviceId,
        keyId,
        protocolVersion: '1.0' as const,
        reason: 'user-request',
        tenantId: vectors.request.projection.tenantId,
      };
      const revokeContext = requestContext({
        body: revokeBody,
        idempotencyKey: '98989898-9898-4989-8989-989898989898',
        method: 'POST',
        path: '/v1/keys/revoke',
        query: '',
        sessionId: undefined,
      });
      const revokeProjection = createRequestProjection(revokeContext);
      const revokeSignature = signProjection(
        REQUEST_SIGNATURE_DOMAIN,
        revokeProjection,
        vectors.privateSeed,
      );
      const revokeIdentity = {
        ...createIdempotentRequestIdentity(revokeProjection),
        kind: 'key.revoke' as const,
      };
      expect(() => verifyBoundRequest(
        revokeProjection,
        revokeSignature,
        revokeContext,
        {
          committedOperation: revokeIdentity,
          isKeyRevoked: () => true,
          now: requestTime + 86_400_000,
        },
      )).not.to.throw();

      const foreignContext = requestContext({
        ...revokeContext,
        body: {...revokeBody, keyId: '15151515-1515-4151-8151-151515151515'},
      });
      const foreignProjection = createRequestProjection(foreignContext);
      expectSigningError(() => verifyBoundRequest(
        foreignProjection,
        signProjection(REQUEST_SIGNATURE_DOMAIN, foreignProjection, vectors.privateSeed),
        foreignContext,
        {
          committedOperation: {
            ...createIdempotentRequestIdentity(foreignProjection),
            kind: 'key.revoke',
          },
          isKeyRevoked: () => true,
          now: requestTime + 86_400_000,
        },
      ), 'binding_mismatch');
    });
  });

  describe('tool authority lifecycle', () => {
    it('verifies every golden digest, signature, authority link, and canonical content digest', () => {
      const {decision, descriptor, grant, proposal, result} = toolRecords();
      const authorities = toolAuthorities();
      expect(() => verifyToolDescriptor(descriptor, authorities.descriptor, limits)).not.to.throw();
      expect(() => verifyToolProposal(proposal, descriptor, authorities, limits)).not.to.throw();
      expect(() => verifyToolDecision(decision, proposal, authorities, limits)).not.to.throw();
      expect(() => verifyToolGrant(grant, proposal, decision, authorities, limits)).not.to.throw();
      expect(() => verifyToolResult(
        result,
        proposal,
        decision,
        grant,
        authorities,
        {evidence: 'evidence-record', limits, output: {lines: 12}},
      )).not.to.throw();

      const altered = toolRecords().descriptor;
      altered.projection.description = 'Rewritten after device authorization';
      altered.descriptorDigest = toolDescriptorDigest(altered.projection);
      expectSigningError(
        () => verifyToolDescriptor(altered, authorities.descriptor, limits),
        'invalid_signature',
      );
    });

    it('pins distinct server tool roles and rejects cross-role signatures', () => {
      const {grant, proposal} = toolRecords();
      const authorities = toolAuthorities();
      expect(authorities.proposal.expectedKeyId).not.to.equal(authorities.grant.expectedKeyId);
      expect(authorities.proposal.publicKey).not.to.equal(authorities.grant.publicKey);
      expectSigningError(
        () => resolveServerToolSigningAuthorities([
          vectors.toolLifecycle.serverSigningKeys[0]!,
          {
            ...vectors.toolLifecycle.serverSigningKeys[1]!,
            keyThumbprint: vectors.toolLifecycle.serverSigningKeys[0]!.keyThumbprint,
            publicKey: vectors.toolLifecycle.serverSigningKeys[0]!.publicKey,
          },
        ]),
        'invalid_tool_authority',
      );

      expectSigningError(
        () => verifyToolProposal(proposal, toolRecords().descriptor, {
          ...authorities,
          proposal: authorities.grant,
        }, limits),
        'binding_mismatch',
      );
      expectSigningError(
        () => verifyToolGrant(grant, proposal, toolRecords().decision, {
          ...authorities,
          grant: authorities.proposal,
        }, limits),
        'binding_mismatch',
      );
    });

    it('atomically consumes one-use grants and rejects expiry or replay', () => {
      const {decision, descriptor, grant, proposal} = toolRecords();
      const consumed = new Set<string>();
      const consumeGrant = (grantId: string, nonce: string) => {
        const identity = `${grantId}:${nonce}`;
        if (consumed.has(identity)) return false;
        consumed.add(identity);
        return true;
      };

      authorizeToolGrantExecution(grant, proposal, decision, toolAuthorities(), {
        consumeGrant,
        descriptor,
        limits,
        now: Date.parse('2026-01-02T03:04:30.000Z'),
      });
      expectSigningError(() => authorizeToolGrantExecution(
        grant,
        proposal,
        decision,
        toolAuthorities(),
        {
          consumeGrant,
          descriptor,
          limits,
          now: Date.parse('2026-01-02T03:04:31.000Z'),
        },
      ), 'grant_reuse');
      expectSigningError(() => authorizeToolGrantExecution(
        toolRecords().grant,
        toolRecords().proposal,
        toolRecords().decision,
        toolAuthorities(),
        {
          consumeGrant: () => true,
          descriptor: toolRecords().descriptor,
          limits,
          now: Date.parse('2026-01-02T03:09:06.000Z'),
        },
      ), 'expired_grant');
    });

    it('revalidates the exact descriptor and arguments before consuming execution authority', () => {
      const {decision, descriptor, grant, proposal} = toolRecords();
      proposal.arguments = {pathDigest: `sha256:${'0'.repeat(64)}`};
      let consumed = false;
      expectSigningError(() => authorizeToolGrantExecution(
        grant,
        proposal,
        decision,
        toolAuthorities(),
        {
          consumeGrant() {
            consumed = true;
            return true;
          },
          descriptor,
          limits,
          now: Date.parse('2026-01-02T03:04:30.000Z'),
        },
      ), 'binding_mismatch');
      expect(consumed).to.equal(false);
    });

    it('rejects open, unsupported, or nonconforming tool input contracts', () => {
      for (const inputSchema of [
        {},
        {maxItems: 1, type: 'array'},
        {maxLength: 1, type: 'string'},
        {
          additionalProperties: false,
          maxProperties: 1,
          properties: {
            nested: {
              additionalProperties: true,
              maxProperties: 0,
              properties: {},
              required: [],
              type: 'object',
            },
          },
          required: ['nested'],
          type: 'object',
        },
        {
          additionalProperties: false,
          maxProperties: 1,
          properties: {
            value: {maxLength: 10, pattern: '.*', type: 'string'},
          },
          required: ['value'],
          type: 'object',
        },
      ] as JsonValue[]) {
        const {descriptor} = toolRecords();
        descriptor.projection.inputSchema = inputSchema;
        descriptor.projection.schemaDigest = digestCanonicalJson(inputSchema);
        descriptor.descriptorDigest = toolDescriptorDigest(descriptor.projection);
        expectSigningError(
          () => verifyToolDescriptor(descriptor, toolAuthorities().descriptor, limits),
          'invalid_tool_schema',
        );
      }

      const inheritedName = toolRecords().descriptor;
      inheritedName.projection.inputSchema = {
        additionalProperties: false,
        maxProperties: 0,
        properties: {},
        required: ['constructor'],
        type: 'object',
      };
      inheritedName.projection.schemaDigest = digestCanonicalJson(
        inheritedName.projection.inputSchema,
      );
      inheritedName.descriptorDigest = toolDescriptorDigest(inheritedName.projection);
      expectSigningError(
        () => verifyToolDescriptor(inheritedName, toolAuthorities().descriptor, limits),
        'invalid_tool_schema',
      );

      const {descriptor, proposal} = toolRecords();
      proposal.arguments = {
        pathDigest: `sha256:${'0'.repeat(64)}`,
        unexpected: true,
      };
      proposal.projection.argumentsDigest = digestCanonicalJson(proposal.arguments);
      proposal.proposalDigest = toolProposalDigest(proposal.projection);
      proposal.authorization.signature = signProjection(
        TOOL_PROPOSAL_DOMAIN,
        proposal.projection,
        vectors.toolLifecycle.proposalPrivateSeed,
      );
      expectSigningError(
        () => verifyToolProposal(proposal, descriptor, toolAuthorities(), limits),
        'invalid_tool_arguments',
      );

      const unicode = toolRecords();
      unicode.descriptor.projection.inputSchema = {
        additionalProperties: false,
        maxProperties: 1,
        properties: {
          value: {maxLength: 1, minLength: 1, type: 'string'},
        },
        required: ['value'],
        type: 'object',
      };
      unicode.descriptor.projection.schemaDigest = digestCanonicalJson(
        unicode.descriptor.projection.inputSchema,
      );
      unicode.descriptor.descriptorDigest = toolDescriptorDigest(
        unicode.descriptor.projection,
      );
      unicode.descriptor.authorization.signature = signProjection(
        TOOL_DESCRIPTOR_DOMAIN,
        unicode.descriptor.projection,
        vectors.privateSeed,
      );
      unicode.proposal.arguments = {value: '😀'};
      unicode.proposal.projection.argumentsDigest = digestCanonicalJson(
        unicode.proposal.arguments,
      );
      unicode.proposal.projection.descriptorDigest = unicode.descriptor.descriptorDigest;
      unicode.proposal.proposalDigest = toolProposalDigest(unicode.proposal.projection);
      unicode.proposal.authorization.signature = signProjection(
        TOOL_PROPOSAL_DOMAIN,
        unicode.proposal.projection,
        vectors.toolLifecycle.proposalPrivateSeed,
      );
      verifyToolProposal(
        unicode.proposal,
        unicode.descriptor,
        toolAuthorities(),
        limits,
      );
    });

    it('rejects digest mismatches, denied grants, excess budgets, and invalid result states', () => {
      {
        const {descriptor, proposal} = toolRecords();
        proposal.arguments = {pathDigest: `sha256:${'0'.repeat(64)}`};
        expectSigningError(
          () => verifyToolProposal(proposal, descriptor, toolAuthorities(), limits),
          'binding_mismatch',
        );
      }

      {
        const {decision, grant, proposal, result} = toolRecords();
        proposal.arguments = {pathDigest: `sha256:${'0'.repeat(64)}`};
        expectSigningError(
          () => verifyToolDecision(decision, proposal, toolAuthorities(), limits),
          'binding_mismatch',
        );
        expectSigningError(
          () => verifyToolGrant(grant, proposal, decision, toolAuthorities(), limits),
          'binding_mismatch',
        );
        expectSigningError(
          () => verifyToolResult(
            result,
            proposal,
            decision,
            grant,
            toolAuthorities(),
            {limits},
          ),
          'binding_mismatch',
        );
      }

      {
        const {decision, grant, proposal} = toolRecords();
        decision.projection.decision = 'denied';
        decision.decisionDigest = toolDecisionDigest(decision.projection);
        decision.authorization.signature = signProjection(
          TOOL_DECISION_DOMAIN,
          decision.projection,
          vectors.privateSeed,
        );
        expectSigningError(
          () => verifyToolGrant(grant, proposal, decision, toolAuthorities(), limits),
          'binding_mismatch',
        );
      }

      {
        const {decision, grant, proposal} = toolRecords();
        grant.projection.allowedLimits = {
          networkRequests: 0,
          outputBytes: 4097,
          wallClockMs: 1000,
        };
        grant.grantDigest = toolGrantDigest(grant.projection);
        grant.authorization.signature = signProjection(
          TOOL_GRANT_DOMAIN,
          grant.projection,
          vectors.toolLifecycle.grantPrivateSeed,
        );
        expectSigningError(
          () => verifyToolGrant(grant, proposal, decision, toolAuthorities(), limits),
          'invalid_grant',
        );
      }

      for (const [name, value] of [
        ['networkRequests', 1025],
        ['outputBytes', 1_048_577],
        ['wallClockMs', 3_600_001],
      ] as const) {
        const {decision, grant, proposal} = toolRecords();
        const overBudget = {
          networkRequests: 0,
          outputBytes: 4096,
          wallClockMs: 1000,
        };
        overBudget[name] = value;
        proposal.projection.budgetEstimate = overBudget;
        proposal.proposalDigest = toolProposalDigest(proposal.projection);
        proposal.authorization.signature = signProjection(
          TOOL_PROPOSAL_DOMAIN,
          proposal.projection,
          vectors.toolLifecycle.proposalPrivateSeed,
        );
        decision.projection.proposalDigest = proposal.proposalDigest;
        decision.decisionDigest = toolDecisionDigest(decision.projection);
        decision.authorization.signature = signProjection(
          TOOL_DECISION_DOMAIN,
          decision.projection,
          vectors.privateSeed,
        );
        grant.projection.proposalDigest = proposal.proposalDigest;
        grant.projection.decisionDigest = decision.decisionDigest;
        const overGrant = {
          networkRequests: 0,
          outputBytes: 4096,
          wallClockMs: 1000,
        };
        overGrant[name] = value;
        grant.projection.allowedLimits = overGrant;
        grant.grantDigest = toolGrantDigest(grant.projection);
        grant.authorization.signature = signProjection(
          TOOL_GRANT_DOMAIN,
          grant.projection,
          vectors.toolLifecycle.grantPrivateSeed,
        );
        expectSigningError(
          () => verifyToolGrant(grant, proposal, decision, toolAuthorities(), limits),
          'invalid_grant',
        );
      }

      {
        const {decision, grant, proposal} = toolRecords();
        grant.projection.allowedLimits = {
          networkRequests: 0,
          outputBytes: 4096,
          wallClockMs: 0,
        };
        grant.grantDigest = toolGrantDigest(grant.projection);
        grant.authorization.signature = signProjection(
          TOOL_GRANT_DOMAIN,
          grant.projection,
          vectors.toolLifecycle.grantPrivateSeed,
        );
        expectSigningError(
          () => verifyToolGrant(grant, proposal, decision, toolAuthorities(), limits),
          'invalid_grant',
        );
      }

      {
        const {decision, grant, proposal, result} = toolRecords();
        result.projection.status = 'ambiguous';
        result.resultDigest = toolResultDigest(result.projection);
        result.authorization.signature = signProjection(
          TOOL_RESULT_DOMAIN,
          result.projection,
          vectors.privateSeed,
        );
        expectSigningError(
          () => verifyToolResult(
            result,
            proposal,
            decision,
            grant,
            toolAuthorities(),
            {limits},
          ),
          'invalid_result',
        );
      }

      {
        const {decision, grant, proposal, result} = toolRecords();
        expectSigningError(() => verifyToolResult(
          result,
          proposal,
          decision,
          grant,
          toolAuthorities(),
          {limits, output: {lines: 13}},
        ), 'binding_mismatch');
      }
    });
  });

  describe('durable signed SSE', () => {
    it('verifies the golden genesis event and emits deterministic replay bytes', () => {
      const envelope = eventEnvelope();
      expect(eventHash(vectors.eventChain.projection)).to.equal(vectors.eventChain.eventHash);
      expect(verifyProjection(
        EVENT_ENVELOPE_DOMAIN,
        vectors.eventChain.projection,
        vectors.eventChain.signature,
        vectors.publicKey,
      )).to.equal(true);
      expect(verifyEventEnvelope(envelope, eventVerification())).to.deep.equal({
        cursor: 1,
        eventHash: vectors.eventChain.eventHash,
      });
      expect(canonicalSseEvent(envelope, limits))
        .to.deep.equal(canonicalSseEvent(structuredClone(envelope), limits));
      expect(canonicalSseEvent(envelope, limits).toString('utf8')).to.match(
        /^id:1\nevent:session\.created\ndata:\{.*\}\n\n$/,
      );
    });

    it('detects sequence, cursor, hash, payload, signature, and unknown-event corruption', () => {
      const mutations: Array<[string, (event: SignedEventEnvelope) => void]> = [
        ['event_sequence_gap', (event) => {
          event.sequence = 2;
          event.cursor = 2;
        }],
        ['binding_mismatch', (event) => {
          event.cursor = 2;
        }],
        ['binding_mismatch', (event) => {
          event.previousEventHash = `sha256:${'0'.repeat(64)}`;
        }],
        ['binding_mismatch', (event) => {
          event.payload = {...vectors.eventChain.payload, snapshotVersion: 2};
        }],
        ['binding_mismatch', (event) => {
          event.eventHash = `sha256:${'0'.repeat(64)}`;
        }],
        ['invalid_base64url', (event) => {
          event.authorization.signature = event.authorization.signature.slice(1);
        }],
        ['unknown_event_type', (event) => {
          event.eventType = 'future.unknown';
        }],
      ];

      for (const [code, mutate] of mutations) {
        const envelope = eventEnvelope();
        mutate(envelope);
        expectSigningError(
          () => verifyEventEnvelope(envelope, eventVerification()),
          code,
        );
      }
    });

    it('requires reconnects to continue from the exact persisted cursor and hash', () => {
      const first = eventEnvelope();
      const head = verifyEventEnvelope(first, eventVerification());
      const payload = {from: 'created', reasonCode: 'planning-started', to: 'planning'};
      const projection = createEventProjection({
        cursor: 2,
        eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        eventType: 'session.state.changed',
        limits,
        occurredAt: '2026-01-02T03:04:09.000Z',
        payload,
        previousEventHash: head.eventHash,
        sequence: 2,
        sessionId: first.sessionId,
        tenantId: first.tenantId,
      });
      const second: SignedEventEnvelope = {
        ...projection,
        authorization: eventAuthorization(signProjection(
          EVENT_ENVELOPE_DOMAIN,
          projection,
          vectors.privateSeed,
        )),
        eventHash: eventHash(projection),
        payload,
      };
      expect(verifyEventEnvelope(second, eventVerification(head))).to.deep.equal({
        cursor: 2,
        eventHash: second.eventHash,
      });
      expectSigningError(
        () => verifyEventEnvelope(
          second,
          eventVerification({cursor: 1, eventHash: `sha256:${'0'.repeat(64)}`}),
        ),
        'binding_mismatch',
      );
    });

    it('rejects unpinned keys and correctly re-signed event/payload type mismatches', () => {
      const unpinned = eventEnvelope();
      unpinned.authorization.keyId = '14141414-1414-4141-8141-141414141414';
      expectSigningError(
        () => verifyEventEnvelope(unpinned, eventVerification()),
        'untrusted_event_key',
      );
      expectSigningError(
        () => verifyEventEnvelope(
          eventEnvelope(),
          eventVerification(
            {cursor: 0, eventHash: null},
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ),
        ),
        'binding_mismatch',
      );

      const mismatched = eventEnvelope();
      const projection = createEventProjection({
        cursor: mismatched.cursor,
        eventId: mismatched.eventId,
        eventType: 'usage.reported',
        limits,
        occurredAt: mismatched.occurredAt,
        payload: mismatched.payload,
        previousEventHash: mismatched.previousEventHash,
        sequence: mismatched.sequence,
        sessionId: mismatched.sessionId,
        tenantId: mismatched.tenantId,
      });
      Object.assign(mismatched, projection, {
        authorization: eventAuthorization(signProjection(
          EVENT_ENVELOPE_DOMAIN,
          projection,
          vectors.privateSeed,
        )),
        eventHash: eventHash(projection),
      });
      expectSigningError(
        () => verifyEventEnvelope(mismatched, eventVerification()),
        'invalid_event_payload',
      );
    });
  });

  describe('closed schemas, recovery, usage, and problem details', () => {
    const ajv = compileSchemas();

    it('strictly compiles every 2020-12 definition with real UUID and date-time formats', () => {
      const uuid = validator(ajv, 'common', 'Uuid');
      const timestamp = validator(ajv, 'common', 'Timestamp');
      expect(uuid('11111111-1111-4111-8111-111111111111')).to.equal(true);
      expect(uuid('not-a-uuid')).to.equal(false);
      expect(timestamp('2026-02-28T03:04:05.000Z')).to.equal(true);
      expect(timestamp('2026-02-30T03:04:05.000Z')).to.equal(false);
      expect(timestamp('2026-01-02T03:04:05+00:00')).to.equal(false);
    });

    it('requires bounded canonical validation after structural schema validation', () => {
      const jsonValue = validator(ajv, 'common', 'JsonValue');
      const multibyte = '\u00E9'.repeat(32_769);
      expect(jsonValue(multibyte)).to.equal(true);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(multibyte),
        'string_too_large',
      );

      let nested: unknown = 0;
      for (let index = 0; index < 33; index++) nested = [nested];
      expect(jsonValue(nested)).to.equal(true);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(nested),
        'too_deep',
      );

      const excessiveNodes = Array.from(
        {length: 100},
        () => Array.from({length: 100}, () => null),
      );
      expect(jsonValue(excessiveNodes)).to.equal(true);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(excessiveNodes),
        'too_many_nodes',
      );

      const excessiveKeys = Object.fromEntries(
        Array.from({length: 257}, (_, index) => [`key${index}`, null]),
      );
      expect(jsonValue(excessiveKeys)).to.equal(false);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(excessiveKeys),
        'object_too_large',
      );

      const excessiveItems = Array.from({length: 1025}, () => null);
      expect(jsonValue(excessiveItems)).to.equal(false);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(excessiveItems),
        'array_too_large',
      );

      const oversizedKey = {['k'.repeat(65_537)]: null};
      expect(jsonValue(oversizedKey)).to.equal(true);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(oversizedKey),
        'string_too_large',
      );

      const aggregatePayload = Array.from({length: 16}, () => 'a'.repeat(65_536));
      expect(jsonValue(aggregatePayload)).to.equal(true);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(aggregatePayload),
        'payload_too_large',
      );
      const expansionString = '\u0000'.repeat(65_536);
      const expansionPayload = Array.from({length: 1024}, () => expansionString);
      expectCanonicalError(
        () => validateBoundedCanonicalJson(expansionPayload),
        'payload_too_large',
      );

      const valid = validateBoundedCanonicalJson({snowman: '\u2603'});
      expect(valid.canonicalJson).to.equal('{"snowman":"\u2603"}');
      expect(valid.payloadBytes).to.equal(Buffer.byteLength(valid.canonicalJson, 'utf8'));
      expect(valid.nodeCount).to.equal(3);
    });

    it('rejects unknown DTO fields and malformed key/signature encodings', () => {
      const request = validator(ajv, 'request-signing', 'RequestSigningProjection');
      expect(request(vectors.request.projection)).to.equal(true);
      expect(request({...vectors.request.projection, unexpected: true})).to.equal(false);

      const enrollment = validator(ajv, 'auth', 'EnrollmentRequest');
      const base = {
        bootstrapToken: 'a'.repeat(32),
        clientCapabilities: {
          compression: ['identity'],
          limits: {
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
            maxToolArgumentsBytes: 524_288,
            maxToolDescriptors: 128,
            maxToolResultValueBytes: 524_288,
          },
          optionalFeatures: [],
          requiredFeatures: ['bound-ed25519-auth'],
          supportedVersions: ['1.0'],
        },
        deviceId: vectors.request.projection.deviceId,
        deviceLabel: 'workstation',
        keyId,
        keyThumbprint: keyThumbprint(vectors.publicKey),
        protocolVersion: '1.0',
        publicKey: vectors.publicKey,
        tenantId: vectors.request.projection.tenantId,
      };
      expect(enrollment(base)).to.equal(true);
      expect(enrollment({...base, publicKey: vectors.publicKey.slice(1)})).to.equal(false);
      const detached = validator(ajv, 'common', 'DetachedSignature');
      expect(detached(authorization(vectors.request.signature))).to.equal(true);
      expect(detached(authorization(vectors.request.signature.slice(1)))).to.equal(false);
      expect(detached(authorization(`${'A'.repeat(85)}B`))).to.equal(false);
      expect(enrollment({...base, publicKey: `${'A'.repeat(42)}B`})).to.equal(false);
      const nonce = validator(ajv, 'common', 'Nonce');
      expect(nonce(Buffer.alloc(16).toString('base64url'))).to.equal(true);
      expect(nonce(Buffer.alloc(64).toString('base64url'))).to.equal(true);
      expect(nonce(`${'A'.repeat(21)}B`)).to.equal(false);
      expect(nonce('A'.repeat(25))).to.equal(false);
      expect(nonce(`${'A'.repeat(85)}B`)).to.equal(false);

      const rotation = validator(ajv, 'auth', 'RotateKeyRequest');
      const rotationRequest = {
        newKeyProof: vectors.keyRotation.proof,
        projection: vectors.keyRotation.projection,
      };
      expect(rotation(rotationRequest), JSON.stringify(rotation.errors)).to.equal(true);
      expect(rotation({...rotationRequest, currentKeyId: keyId})).to.equal(false);
      expect(rotation({
        ...rotationRequest,
        projection: {...rotationRequest.projection, unexpected: true},
      })).to.equal(false);

      const serverEventKey = validator(ajv, 'capabilities', 'ServerEventSigningKey');
      expect(serverEventKey(vectors.eventChain.serverSigningKey)).to.equal(true);
      expect(serverEventKey({
        ...vectors.eventChain.serverSigningKey,
        privateKey: 'must-not-appear',
      })).to.equal(false);
      expect(() => validateServerEventSigningKeys([
        vectors.eventChain.serverSigningKey,
        {
          ...vectors.eventChain.serverSigningKey,
          keyThumbprint: keyThumbprint(vectors.keyRotation.projection.newPublicKey),
          publicKey: vectors.keyRotation.projection.newPublicKey,
        },
      ])).to.throw(ProtocolSigningError).with.property('code', 'invalid_event_key');
      expect(() => validateServerEventSigningKeys([
        vectors.eventChain.serverSigningKey,
        {
          ...vectors.eventChain.serverSigningKey,
          keyId: '16161616-1616-4161-8161-161616161616',
        },
      ])).to.throw(ProtocolSigningError).with.property('code', 'invalid_event_key');

      const serverToolKey = validator(ajv, 'capabilities', 'ServerToolSigningKey');
      for (const signingKey of vectors.toolLifecycle.serverSigningKeys) {
        expect(serverToolKey(signingKey), JSON.stringify(serverToolKey.errors)).to.equal(true);
      }

      expect(serverToolKey({
        ...vectors.toolLifecycle.serverSigningKeys[0],
        role: 'result',
      })).to.equal(false);

      const negotiated = validator(ajv, 'capabilities', 'NegotiatedCapabilities');
      const capabilities = {
        compression: 'identity',
        features: [
          'bound-ed25519-auth',
          'canonical-request-signing',
          'durable-idempotency',
          'negotiated-limit-profile-v1',
          'normalized-recovery-lineage-v1',
          'operation-recovery',
          'snapshot-pagination-v1',
          'pinned-server-event-keys',
          'signed-hash-chain-sse',
          'tool-authority-v1',
          'usage-reconciliation-v1',
        ],
        limitProfileDigest,
        limits: base.clientCapabilities.limits,
        protocolVersion: '1.0',
        serverEventSigningKeys: [vectors.eventChain.serverSigningKey],
        serverManifestDigest: `sha256:${'0'.repeat(64)}`,
        serverToolSigningKeys: vectors.toolLifecycle.serverSigningKeys,
      };
      expect(negotiated(capabilities), JSON.stringify(negotiated.errors)).to.equal(true);
      expect(negotiated({...capabilities, serverToolSigningKeys: []})).to.equal(false);
      expect(negotiated({
        ...capabilities,
        serverToolSigningKeys: [
          capabilities.serverToolSigningKeys[0],
          capabilities.serverToolSigningKeys[0],
        ],
      })).to.equal(false);
      expectSigningError(() => resolveServerToolSigningAuthorities([
        capabilities.serverToolSigningKeys[0],
        {
          ...capabilities.serverToolSigningKeys[1],
          keyThumbprint: capabilities.serverToolSigningKeys[0].keyThumbprint,
          publicKey: capabilities.serverToolSigningKeys[0].publicKey,
        },
      ]), 'invalid_tool_authority');
    });

    it('couples every event discriminant to its exact closed payload', () => {
      const event = validator(ajv, 'events', 'EventEnvelope');
      const envelope = eventEnvelope();
      expect(event(envelope), JSON.stringify(event.errors)).to.equal(true);
      expect(event({...envelope, eventType: 'usage.reported'})).to.equal(false);
      expect(event({...envelope, eventType: 'future.unknown'})).to.equal(false);
      expect(event({...envelope, unknown: true})).to.equal(false);
      expect(event({...envelope, payload: {snapshotVersion: 1}})).to.equal(false);
    });

    it('rejects contradictory usage meters and separates informational from billing records', () => {
      const usage = validator(ajv, 'usage', 'UsageRecord');
      const provider = {
        authoritative: false,
        meters: [{amount: 12, meter: 'input_tokens', unit: 'tokens'}],
        model: 'private-model',
        observedAt: '2026-01-02T03:04:05.000Z',
        protocolVersion: '1.0',
        provider: 'private-provider',
        reconciliationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: vectors.request.projection.sessionId,
        tenantId: vectors.request.projection.tenantId,
        usageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      };
      expect(usage(provider)).to.equal(true);
      expect(usage({
        ...provider,
        meters: [{amount: 12, meter: 'input_tokens', unit: 'bytes'}],
      })).to.equal(false);
      expect(usage({
        ...provider,
        meters: [{amount: -1, meter: 'requests', unit: 'count'}],
      })).to.equal(false);
      expect(usage({...provider, authoritative: true})).to.equal(false);

      const billing = {
        authoritative: true,
        billingRecordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        meters: [{amount: '0.001000000', currency: 'USD', meter: 'cost', unit: 'currency'}],
        protocolVersion: '1.0',
        reconciliationId: provider.reconciliationId,
        sessionId: provider.sessionId,
        settledAt: '2026-01-02T03:05:05.000Z',
        sourceUsageIds: [provider.usageId],
        tenantId: provider.tenantId,
      };
      expect(usage(billing)).to.equal(true);
      expect(usage({...billing, provider: 'must-not-appear'})).to.equal(false);
    });

    it('validates bounded immutable recovery pages and session checkpoints', () => {
      const operation = recoveryOperation(1);
      expect(validator(ajv, 'operations', 'Operation')(operation.operation)).to.equal(true);
      expect(validator(ajv, 'operations', 'Operation')({
        ...operation.operation,
        kind: 'auth.enroll',
      })).to.equal(true);
      expect(validator(ajv, 'operations', 'Operation')({
        ...operation.operation,
        kind: 'auth.refresh',
      })).to.equal(true);
      const checkpoint = {
        createdAt: '2026-01-02T03:04:05.000Z',
        eventHead: {cursor: 1, eventHash: vectors.eventChain.eventHash},
        protocolVersion: '1.0',
        sessionId: vectors.request.projection.sessionId,
        state: 'awaiting-result',
        tenantId: vectors.request.projection.tenantId,
        updatedAt: '2026-01-02T03:04:10.000Z',
      };
      const validateCheckpoint = validator(ajv, 'sessions', 'SessionCheckpoint');
      expect(
        validateCheckpoint(checkpoint),
        JSON.stringify(validateCheckpoint.errors),
      ).to.equal(true);
      expect(validateCheckpoint({
        ...checkpoint,
        eventHead: {cursor: 0, eventHash: vectors.eventChain.eventHash},
      })).to.equal(false);
      expect(validateCheckpoint({
        ...checkpoint,
        eventHead: {cursor: 1, eventHash: null},
      })).to.equal(false);
      expect(
        validateCheckpoint({...checkpoint, eventHead: {cursor: 0, eventHash: null}}),
      ).to.equal(true);

      const [page] = recoveryPages([operation]);
      const validateSnapshotPage = validator(ajv, 'sessions', 'SessionSnapshotPage');
      expect(
        validateSnapshotPage(page),
        JSON.stringify(validateSnapshotPage.errors),
      ).to.equal(true);
      expect(validateSnapshotPage({...page, unexpected: true})).to.equal(false);
      expect(validateSnapshotPage({
        ...page,
        collection: 'decisions',
      })).to.equal(false);
      verifySnapshotPage(
        page,
        {...snapshotContext(page), expectedPageStart: 0},
        snapshotAuthority(),
        Date.parse('2026-01-02T03:05:00.000Z'),
      );

      const expectedContext = {...snapshotContext(page), expectedPageStart: 0};
      for (const alteredPage of [
        {...page, tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},
        {...page, snapshotId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},
        {...page, snapshotVersion: 2},
        {...page, collection: 'decisions'},
        {
          ...page,
          collectionBoundaries: {
            ...page.collectionBoundaries,
            operations: {
              ...page.collectionBoundaries.operations,
              collectionDigest: `sha256:${'ef'.repeat(32)}`,
            },
          },
        },
      ]) {
        expectSigningError(
          () => verifySnapshotPage(
            alteredPage as SnapshotPage,
            expectedContext,
            snapshotAuthority(),
            Date.parse('2026-01-02T03:05:00.000Z'),
          ),
          'snapshot_cursor_mismatch',
        );
      }

      const foreignTerminalRecord = structuredClone(page);
      (foreignTerminalRecord.items[0] as {sessionId: string}).sessionId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      expectSigningError(
        () => verifySnapshotPage(
          foreignTerminalRecord,
          expectedContext,
          snapshotAuthority(),
          Date.parse('2026-01-02T03:05:00.000Z'),
        ),
        'snapshot_integrity_failed',
      );
    });

    it('reconstructs more than 1,024 records without gaps or duplicates', () => {
      const operations = Array.from({length: 1025}, (_, index) => recoveryOperation(index));
      const pages = recoveryPages(operations);
      const validateSnapshotPage = validator(ajv, 'sessions', 'SessionSnapshotPage');
      expect(pages).to.have.length(9);
      for (const page of pages) {
        expect(
          validateSnapshotPage(page),
          JSON.stringify(validateSnapshotPage.errors),
        ).to.equal(true);
      }

      const now = Date.parse('2026-01-02T03:05:00.000Z');
      const context = snapshotContext(pages[0]);
      const assembled = assembleSnapshotCollection(pages, context, snapshotAuthority(), now);
      expect(assembled).to.deep.equal(operations);
      expect(() => assembleSnapshotCollection(
        pages.filter((_, index) => index !== 3),
        context,
        snapshotAuthority(),
        now,
      )).to.throw(ProtocolSigningError).with.property('code', 'snapshot_integrity_failed');
      expect(() => assembleSnapshotCollection(
        [pages[0], pages[0], ...pages.slice(1)],
        context,
        snapshotAuthority(),
        now,
      )).to.throw(ProtocolSigningError).with.property('code', 'snapshot_integrity_failed');
      const emptyPages = recoveryPages([]);
      expectSigningError(
        () => assembleSnapshotCollection(
          [emptyPages[0], emptyPages[0]],
          snapshotContext(emptyPages[0]),
          snapshotAuthority(),
          now,
        ),
        'snapshot_integrity_failed',
      );
      expectSigningError(
        () => assembleSnapshotCollection(
          pages,
          {...context, tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},
          snapshotAuthority(),
          now,
        ),
        'snapshot_cursor_mismatch',
      );

      const foreignItemPages = structuredClone(pages);
      (foreignItemPages[0].items[0] as {sessionId: string}).sessionId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      expectSigningError(
        () => assembleSnapshotCollection(
          foreignItemPages,
          context,
          snapshotAuthority(),
          now,
        ),
        'snapshot_integrity_failed',
      );

      const firstCursorToken = pages[0].nextCursor as string;
      const firstCursor = decodeSnapshotCursor(firstCursorToken);
      expect(encodeSnapshotCursor(firstCursor)).to.equal(firstCursorToken);
      const cursorContext = {
        ...firstCursor.projection,
        expectedOffset: firstCursor.projection.nextOffset,
        limits,
        snapshotExpiresAt: firstCursor.projection.expiresAt,
      };
      verifySnapshotCursor(firstCursor, cursorContext, snapshotAuthority(), now);
      expectSigningError(
        () => verifySnapshotCursor(
          firstCursor,
          {...cursorContext, snapshotId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},
          snapshotAuthority(),
          now,
        ),
        'snapshot_cursor_mismatch',
      );
      expectSigningError(
        () => verifySnapshotCursor(
          firstCursor,
          {
            ...cursorContext,
            collection: 'decisions',
            collectionDigest: pages[0].collectionBoundaries.decisions.collectionDigest,
          },
          snapshotAuthority(),
          now,
        ),
        'snapshot_cursor_mismatch',
      );
      expectSigningError(
        () => verifySnapshotPage(
          pages[0],
          {...snapshotContext(pages[0]), expectedPageStart: 0},
          snapshotAuthority(),
          Date.parse(pages[0].snapshotExpiresAt),
        ),
        'snapshot_expired',
      );

      const repeated = recoveryPages(operations);
      expect(repeated[0].nextCursor).to.equal(pages[0].nextCursor);
      const restarted = recoveryPages(
        operations,
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        '2026-01-02T03:24:08.000Z',
        '2026-01-02T03:44:08.000Z',
      );
      expect(
        assembleSnapshotCollection(
          restarted,
          snapshotContext(restarted[0]),
          snapshotAuthority(),
          Date.parse('2026-01-02T03:25:00.000Z'),
        ),
      ).to.deep.equal(operations);
    });

    it('matches the deterministic signed snapshot cursor vector', () => {
      const vector = vectors.snapshotCursor;
      const cursor = decodeSnapshotCursor(vector.token);
      expect(canonicalizeJson(cursor)).to.equal(vector.canonicalCursor);
      expect(cursor.authorization.signature).to.equal(vector.signature);
      expect(encodeSnapshotCursor(cursor)).to.equal(vector.token);
      expect(snapshotCollectionBoundary('operations', [], limits).collectionDigest)
        .to.equal(vector.collectionGenesisDigest);
      expect(vector.negative).to.deep.equal([
        'cross-snapshot-reuse',
        'cross-collection-reuse',
        'altered-offset',
        'altered-boundary-digest',
        'expired-snapshot',
        'noncanonical-token',
      ]);
      verifySnapshotCursor(
        cursor,
        {
          ...vector.projection,
          expectedOffset: vector.projection.nextOffset,
          limits,
          snapshotExpiresAt: vector.projection.expiresAt,
        },
        snapshotAuthority(),
        Date.parse('2026-01-02T03:05:00.000Z'),
      );
    });

    it('verifies completed result lineage from recovery artifacts alone', () => {
      const {decision, grant, proposal, result} = toolRecords();
      const collectionBoundaries = {
        ...recoveryBoundaries([]),
        decisions: snapshotCollectionBoundary('decisions', [decision], limits),
        grants: snapshotCollectionBoundary('grants', [grant], limits),
        proposals: snapshotCollectionBoundary('proposals', [proposal], limits),
        results: snapshotCollectionBoundary('results', [result], limits),
      };
      const pages = {
        decisions: recoveryPage('decisions', [decision], collectionBoundaries),
        grants: recoveryPage('grants', [grant], collectionBoundaries),
        proposals: recoveryPage('proposals', [proposal], collectionBoundaries),
        results: recoveryPage('results', [result], collectionBoundaries),
      };
      const validatePage = validator(ajv, 'sessions', 'SessionSnapshotPage');
      for (const page of Object.values(pages)) {
        expect(validatePage(page), JSON.stringify(validatePage.errors)).to.equal(true);
      }

      const now = Date.parse('2026-01-02T03:05:00.000Z');
      const recovered = {
        decisions: assembleSnapshotCollection(
          [pages.decisions],
          snapshotContext(pages.decisions),
          snapshotAuthority(),
          now,
        ) as readonly SignedToolDecision[],
        grants: assembleSnapshotCollection(
          [pages.grants],
          snapshotContext(pages.grants),
          snapshotAuthority(),
          now,
        ) as readonly SignedToolGrant[],
        proposals: assembleSnapshotCollection(
          [pages.proposals],
          snapshotContext(pages.proposals),
          snapshotAuthority(),
          now,
        ) as readonly SignedToolProposal[],
      };
      const [recoveredResult] = assembleSnapshotCollection(
        [pages.results],
        snapshotContext(pages.results),
        snapshotAuthority(),
        now,
      ) as readonly SignedToolResult[];
      verifyRecoveredToolResult(recoveredResult, recovered, toolAuthorities(), limits);

      const tampered = structuredClone(recovered);
      tampered.decisions[0]!.projection.proposalId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      expectSigningError(
        () => verifyRecoveredToolResult(recoveredResult, tampered, toolAuthorities(), limits),
        'snapshot_integrity_failed',
      );
    });

    it('accepts boundary lifecycle values only when every recovery artifact and page stays bounded', () => {
      const base = toolRecords();
      const inputSchema: JsonValue = {
        additionalProperties: false,
        maxProperties: 1,
        properties: {
          chunks: {
            items: {maxLength: 65_536, type: 'string'},
            maxItems: 8,
            type: 'array',
          },
        },
        required: ['chunks'],
        type: 'object',
      };
      const descriptorProjection: ToolDescriptorProjection = {
        ...base.descriptor.projection,
        inputSchema,
        schemaDigest: digestCanonicalJson(inputSchema),
      };
      const descriptor: SignedToolDescriptor = {
        authorization: authorization(
          signProjection(TOOL_DESCRIPTOR_DOMAIN, descriptorProjection, vectors.privateSeed),
        ),
        descriptorDigest: toolDescriptorDigest(descriptorProjection),
        projection: descriptorProjection,
      };

      const createProposal = (argumentsValue: Record<string, JsonValue>, proposalId: string) => {
        const projection: ToolProposalProjection = {
          ...base.proposal.projection,
          argumentsDigest: digestCanonicalJson(argumentsValue),
          descriptorDigest: descriptor.descriptorDigest,
          proposalId,
        };
        return {
          arguments: argumentsValue,
          authorization: authorization(
            signProjection(
              TOOL_PROPOSAL_DOMAIN,
              projection,
              vectors.toolLifecycle.proposalPrivateSeed,
            ),
            toolAuthorities().proposal.expectedKeyId,
          ),
          projection,
          proposalDigest: toolProposalDigest(projection),
        } satisfies SignedToolProposal;
      };

      const maximumArguments = exactCanonicalSizeObject(MAX_TOOL_ARGUMENTS_BYTES);
      const proposal = createProposal(maximumArguments, indexedUuid(0x10));
      const secondProposal = createProposal(maximumArguments, indexedUuid(0x11));
      verifyToolProposal(proposal, descriptor, toolAuthorities(), limits);
      expect(validateBoundedCanonicalJson(proposal).payloadBytes)
        .to.be.at.most(MAX_RECOVERY_ITEM_BYTES);
      expect(() => snapshotCollectionBoundary('proposals', [proposal, secondProposal], limits))
        .not.to.throw();

      const proposalBoundary = snapshotCollectionBoundary(
        'proposals',
        [proposal, secondProposal],
        limits,
      );
      const boundaries = {
        ...recoveryBoundaries([]),
        proposals: proposalBoundary,
      };
      const packed = selectSnapshotPageItems(
        [proposal, secondProposal],
        0,
        (items) => recoveryPage('proposals', items, boundaries),
        limits,
      );
      expect(packed.length).to.be.within(1, limits.maxRecoveryPageItems);
      const packedPage = recoveryPage('proposals', packed, boundaries);
      expect(validateBoundedCanonicalJson(packedPage).payloadBytes)
        .to.be.at.most(PROTOCOL_CANONICAL_LIMITS.maxPayloadBytes);
      expect(packed.length).to.be.at.most(MAX_RECOVERY_PAGE_ITEMS);

      const oversizedArguments = exactCanonicalSizeObject(MAX_TOOL_ARGUMENTS_BYTES + 1);
      const oversizedProposal = createProposal(oversizedArguments, indexedUuid(0x12));
      expectCanonicalError(
        () => verifyToolProposal(oversizedProposal, descriptor, toolAuthorities(), limits),
        'payload_too_large',
      );

      const maximumOutput = exactCanonicalSizeObject(MAX_TOOL_RESULT_VALUE_BYTES);
      const resultProjection: ToolResultProjection = {
        ...base.result.projection,
        outputDigest: digestCanonicalJson(maximumOutput),
      };
      const result: SignedToolResult = {
        authorization: authorization(
          signProjection(TOOL_RESULT_DOMAIN, resultProjection, vectors.privateSeed),
        ),
        projection: resultProjection,
        resultDigest: toolResultDigest(resultProjection),
      };
      verifyToolResult(
        result,
        base.proposal,
        base.decision,
        base.grant,
        toolAuthorities(),
        {limits, output: maximumOutput},
      );
      expect(() => snapshotCollectionBoundary('results', [result], limits)).not.to.throw();
      const resultBoundaries = {
        ...recoveryBoundaries([]),
        results: snapshotCollectionBoundary('results', [result], limits),
      };
      expect(validateBoundedCanonicalJson(
        recoveryPage('results', [result], resultBoundaries),
      ).payloadBytes).to.be.at.most(PROTOCOL_CANONICAL_LIMITS.maxPayloadBytes);

      const oversizedOutput = exactCanonicalSizeObject(MAX_TOOL_RESULT_VALUE_BYTES + 1);
      const oversizedResultProjection: ToolResultProjection = {
        ...result.projection,
        outputDigest: digestCanonicalJson(oversizedOutput),
      };
      const oversizedResult: SignedToolResult = {
        authorization: authorization(
          signProjection(TOOL_RESULT_DOMAIN, oversizedResultProjection, vectors.privateSeed),
        ),
        projection: oversizedResultProjection,
        resultDigest: toolResultDigest(oversizedResultProjection),
      };
      expectCanonicalError(
        () => verifyToolResult(
          oversizedResult,
          base.proposal,
          base.decision,
          base.grant,
          toolAuthorities(),
          {limits, output: oversizedOutput},
        ),
        'payload_too_large',
      );
    });

    it('exposes every valid top-level wire document through the closed root union', () => {
      const protocolSchema = JSON.parse(fs.readFileSync(
        path.join(schemaDirectory, 'protocol.schema.json'),
        'utf8',
      )) as {
        $id: string;
        oneOf: Array<{$ref: string}>;
      };
      expect(protocolSchema.oneOf.map((entry) => entry.$ref)).to.deep.equal([
        'auth.schema.json#/$defs/EnrollmentRequest',
        'auth.schema.json#/$defs/EnrollmentResponse',
        'auth.schema.json#/$defs/RefreshRequest',
        'auth.schema.json#/$defs/BoundTokenSet',
        'auth.schema.json#/$defs/RotateKeyRequest',
        'auth.schema.json#/$defs/KeyRotationResponse',
        'auth.schema.json#/$defs/RevokeKeyRequest',
        'sessions.schema.json#/$defs/CreateSessionRequest',
        'sessions.schema.json#/$defs/SessionControlRequest',
        'sessions.schema.json#/$defs/SessionCheckpoint',
        'sessions.schema.json#/$defs/SessionSnapshotPage',
        'events.schema.json#/$defs/EventEnvelope',
        'tools.schema.json#/$defs/ToolDescriptor',
        'tools.schema.json#/$defs/ToolProposal',
        'tools.schema.json#/$defs/ToolDecision',
        'tools.schema.json#/$defs/ToolGrant',
        'tools.schema.json#/$defs/ToolResult',
        'usage.schema.json#/$defs/UsageRecord',
        'operations.schema.json#/$defs/Operation',
        'problem.schema.json#/$defs/Problem',
        'manifest.schema.json',
      ]);

      const protocolMessage = ajv.getSchema(protocolSchema.$id);
      expect(protocolMessage).to.be.a('function');
      if (!protocolMessage) throw new Error('missing root protocol validator');
      const {decision, descriptor, result} = toolRecords();
      const [snapshotPage] = recoveryPages([recoveryOperation(1)]);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, 'protocol', 'manifest.json'), 'utf8'),
      ) as JsonValue;
      for (const [label, message] of [
        ['bound tokens', {
          accessClaims: requestContext().tokenClaims,
          accessToken: 'a'.repeat(32),
          refreshExpiresAt: '2026-02-02T03:04:05.000Z',
          refreshToken: 'r'.repeat(32),
        }],
        ['rotation request', {
          newKeyProof: vectors.keyRotation.proof,
          projection: vectors.keyRotation.projection,
        }],
        ['tool descriptor', descriptor],
        ['tool decision', decision],
        ['tool result', result],
        ['snapshot page', snapshotPage],
        ['protocol manifest', manifest],
      ]) {
        expect(
          protocolMessage(message),
          `${label}: ${JSON.stringify(protocolMessage.errors)}`,
        ).to.equal(true);
      }
    });

    it('freezes the manifest to the exact ordered protocol inventory', () => {
      const validateManifest = ajv.getSchema(
        'https://shadow-auditor.dev/protocol/1.0/schemas/manifest.schema.json',
      );
      expect(validateManifest).to.be.a('function');
      if (!validateManifest) throw new Error('missing manifest validator');
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, 'protocol', 'manifest.json'), 'utf8'),
      ) as {
        canonicalJson: {limits: Record<string, number>};
        files: Array<{path: string}>;
        requiredFeatures: string[];
      };
      expect(validateManifest(manifest), JSON.stringify(validateManifest.errors)).to.equal(true);

      const traversal = structuredClone(manifest);
      traversal.files[0]!.path = 'protocol/../openapi.json';
      expect(validateManifest(traversal)).to.equal(false);

      const duplicate = structuredClone(manifest);
      duplicate.files[1]!.path = duplicate.files[0]!.path;
      expect(validateManifest(duplicate)).to.equal(false);

      const reordered = structuredClone(manifest);
      [reordered.files[0], reordered.files[1]] = [reordered.files[1]!, reordered.files[0]!];
      expect(validateManifest(reordered)).to.equal(false);

      const missing = structuredClone(manifest);
      missing.files.pop();
      expect(validateManifest(missing)).to.equal(false);

      const featureDowngrade = structuredClone(manifest);
      featureDowngrade.requiredFeatures.pop();
      expect(validateManifest(featureDowngrade)).to.equal(false);

      const validateCapabilities = validator(ajv, 'capabilities', 'ClientCapabilities');
      expect(validateCapabilities({
        compression: ['identity'],
        limits: manifest.canonicalJson.limits,
        optionalFeatures: [],
        requiredFeatures: manifest.requiredFeatures,
        supportedVersions: ['1.0'],
      }), JSON.stringify(validateCapabilities.errors)).to.equal(true);
    });

    it('uses closed RFC 9457 problem details with stable codes and request IDs', () => {
      const problem = validator(ajv, 'problem', 'Problem');
      const value = {
        code: 'idempotency_conflict',
        detail: 'The request identifiers were already committed with different signed metadata.',
        instance: `/v1/operations/${vectors.request.projection.requestId}`,
        requestId: vectors.request.projection.requestId,
        retryable: false,
        status: 409,
        title: 'Idempotency conflict',
        type: 'https://shadow-auditor.dev/problems/idempotency-conflict',
      };
      expect(problem(value)).to.equal(true);
      expect(problem({...value, code: 'stack_trace'})).to.equal(false);
      expect(problem({...value, token: vectors.request.accessToken})).to.equal(false);
    });
  });

  describe('OpenAPI and deterministic source-controlled artifacts', () => {
    it('uses explicit signing headers and freezes fail-closed authority and replay rules', () => {
      const openapi = JSON.parse(
        fs.readFileSync(path.join(root, 'protocol', 'openapi.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(openapi.openapi).to.equal('3.1.0');
      expect(openapi).to.have.property('x-shadow-authority-boundary');
      expect(openapi).to.have.property('x-shadow-request-signing');
      expect(openapi).to.have.property('x-shadow-idempotency');
      expect(openapi).to.have.property('x-shadow-key-rotation');
      expect(openapi).to.have.property('x-shadow-tool-authority');
      expect(openapi).to.have.property('x-shadow-sse');
      expect(openapi).to.have.property('x-shadow-version-negotiation');
      expect(JSON.stringify(openapi)).not.to.include('AllSignedHeaders');

      const paths = openapi.paths as Record<string, Record<string, Record<string, unknown>>>;
      expect(paths).to.have.property('/v1/operations/{operationRequestId}');
      expect(paths).not.to.have.property('/v1/operations/{requestId}');
      const recoveryParameters = paths['/v1/operations/{operationRequestId}'].get
        .parameters as Array<{name?: string}>;
      expect(recoveryParameters.map(({name}) => name)).to.include('operationRequestId');
      for (const item of Object.values(paths)) {
        for (const operation of Object.values(item)) {
          if (!operation.security) continue;
          const parameters = operation.parameters as Array<{$ref?: string; name?: string}>;
          const names = parameters.map(({$ref, name}) => name ?? $ref?.split('/').at(-1));
          for (const required of [
            'AccessTokenDigest',
            'BodyDigest',
            'DeviceId',
            'KeyId',
            'Nonce',
            'ProtocolVersion',
            'RequestId',
            'Signature',
            'TenantId',
            'Timestamp',
          ]) {
            expect(names, required).to.include(required);
          }
        }
      }

      for (const route of ['/v1/auth/refresh', '/v1/enrollments']) {
        const parameters = paths[route].post.parameters as Array<{$ref: string}>;
        expect(parameters.map((parameter) => parameter.$ref)).to.include(
          '#/components/parameters/IdempotencyKey',
        );
      }

      const rotationResponses = paths['/v1/keys/rotate'].post.responses as Record<
        string,
        {content: {'application/json': {schema: {$ref: string}}}}
      >;
      expect(rotationResponses['200'].content['application/json'].schema.$ref).to.equal(
        './schemas/auth.schema.json#/$defs/KeyRotationResponse',
      );
      const packageManifest = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
      ) as {files: string[]; scripts: Record<string, string>};
      expect(packageManifest.files).to.include('./protocol');
      expect(packageManifest.files).to.include('./scripts/generate-protocol.mjs');
      expect(packageManifest.files).to.include('./src/protocol');
      expect(packageManifest.scripts.test).to.equal(
        'mocha --forbid-only --extension ts --recursive test',
      );
      const manifestResponse = paths['/v1/protocol/manifest'].get.responses as Record<
        string,
        {content: {'application/json': {schema: {$ref: string}}}}
      >;
      expect(manifestResponse['200'].content['application/json'].schema.$ref).to.equal(
        './schemas/manifest.schema.json',
      );

      const generatedDtos = fs.readFileSync(
        path.join(root, 'src', 'protocol', 'generated', 'dtos.ts'),
        'utf8',
      );
      expect(generatedDtos).not.to.include('export type ProtocolManifest = unknown;');
      expect(generatedDtos).to.match(
        /export type ProtocolManifest = Readonly<\{.*readonly "files": readonly \[/,
      );
      expect(generatedDtos).to.match(
        /readonly "requiredFeatures": readonly \["bound-ed25519-auth","canonical-request-signing"/,
      );
      expect(generatedDtos).to.match(
        /readonly "files": readonly \[.*"protocol\/openapi\.json".*"src\/protocol\/signing\.ts"/,
      );
      expect(generatedDtos).to.match(
        /export type ToolDescriptor = Readonly<\{readonly "authorization":/,
      );
      expect(generatedDtos).to.match(
        /export type ToolInputSchema = .*ToolInputSchema/,
      );
    });

  });
});
