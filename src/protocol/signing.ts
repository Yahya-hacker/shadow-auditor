import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';

import type {
  BoundTokenClaims,
  KeyRotationProjection,
  RequestSigningProjection,
  RotateKeyRequest,
  ServerEventSigningKey,
  ServerToolSigningKey,
} from './generated/dtos.js';

import {
  canonicalizeJson,
  digestCanonicalJson,
  EMPTY_BODY_SHA256,
  JsonValue,
  parseStrictJson,
  sha256Bytes,
} from './canonical-json.js';

export const PROTOCOL_VERSION = '1.0';
export const REQUEST_SIGNATURE_DOMAIN = 'shadow-auditor/request-signature/v1';
export const KEY_ROTATION_DOMAIN = 'shadow-auditor/key-rotation/v1';
export const TOOL_DESCRIPTOR_DOMAIN = 'shadow-auditor/tool-descriptor/v1';
export const TOOL_PROPOSAL_DOMAIN = 'shadow-auditor/tool-proposal/v1';
export const TOOL_DECISION_DOMAIN = 'shadow-auditor/tool-decision/v1';
export const TOOL_GRANT_DOMAIN = 'shadow-auditor/tool-grant/v1';
export const TOOL_RESULT_DOMAIN = 'shadow-auditor/tool-result/v1';
export const EVENT_ENVELOPE_DOMAIN = 'shadow-auditor/event-envelope/v1';
export const SNAPSHOT_CURSOR_DOMAIN = 'shadow-auditor/snapshot-cursor/v1';
export const SNAPSHOT_COLLECTION_DOMAIN = 'shadow-auditor/snapshot-collection/v1';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^sha256:[\da-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PRIVATE_KEY_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface RequestProjectionInput {
  accessToken?: string;
  body?: JsonValue;
  bodyMediaType?: RequestSigningProjection['bodyMediaType'];
  deviceId: string;
  idempotencyKey?: string;
  keyId: string;
  method: string;
  nonce: string;
  path: string;
  query?: string;
  requestId: string;
  sessionId?: string;
  tenantId: string;
  timestamp: string;
}

export interface RequestBindingContext extends RequestProjectionInput {
  bodyIds?: Partial<Pick<RequestSigningProjection, 'deviceId' | 'keyId' | 'requestId' | 'sessionId' | 'tenantId'>>;
  publicKey: string;
  tokenClaims?: BoundTokenClaims;
}

export interface DetachedSignature {
  algorithm: 'Ed25519';
  keyId: string;
  signature: string;
}

export interface ToolDescriptorProjection {
  description: string;
  inputSchema: JsonValue;
  name: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  schemaDigest: string;
  tenantId: string;
  version: string;
}

export interface ToolProposalProjection {
  argumentsDigest: string;
  budgetEstimate: JsonValue;
  descriptorDigest: string;
  expiresAt: string;
  proposalId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  risk: 'critical' | 'high' | 'low' | 'medium';
  sessionId: string;
  tenantId: string;
  toolName: string;
}

export interface ToolDecisionProjection {
  decidedAt: string;
  decision: 'approved' | 'denied';
  decisionId: string;
  proposalDigest: string;
  proposalId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  reason: null | string;
  sessionId: string;
  tenantId: string;
}

export interface ToolGrantProjection {
  allowedLimits: JsonValue;
  decision: 'approved';
  decisionDigest: string;
  expiresAt: string;
  grantId: string;
  oneUseNonce: string;
  proposalDigest: string;
  proposalId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  tenantId: string;
}

export interface ToolResultProjection {
  completedAt: string;
  decisionDigest: string;
  errorDigest: null | string;
  evidenceDigest: string;
  executionLedgerId: string;
  grantDigest: string;
  grantId: string;
  outputDigest: string;
  proposalDigest: string;
  proposalId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  resultId: string;
  sessionId: string;
  status: 'ambiguous' | 'cancelled' | 'denied' | 'failed' | 'succeeded' | 'timeout';
  tenantId: string;
}

export interface EventProjection {
  cursor: number;
  eventId: string;
  eventType: string;
  occurredAt: string;
  payloadDigest: string;
  previousEventHash: null | string;
  protocolVersion: typeof PROTOCOL_VERSION;
  sequence: number;
  sessionId: string;
  tenantId: string;
}

export interface IdempotentRequestIdentity {
  deviceId: string;
  idempotencyKey: string;
  requestDigest: string;
  requestId: string;
  tenantId: string;
}

export interface CommittedRequestIdentity extends IdempotentRequestIdentity {
  kind?: 'auth.enroll' | 'auth.refresh' | 'key.revoke' | 'key.rotate' | 'session.control' | 'session.create' | 'tool.decision' | 'tool.result';
}

export interface SignedToolDescriptor {
  authorization: DetachedSignature;
  descriptorDigest: string;
  projection: ToolDescriptorProjection;
}

export interface SigningAuthority {
  expectedKeyId?: string;
  publicKey: string;
}

export interface ToolLifecycleAuthorities {
  decision: SigningAuthority;
  descriptor: SigningAuthority;
  grant: SigningAuthority;
  proposal: SigningAuthority;
  result: SigningAuthority;
}

export interface SignedToolProposal {
  arguments: JsonValue;
  authorization: DetachedSignature;
  projection: ToolProposalProjection;
  proposalDigest: string;
}

export interface SignedToolDecision {
  authorization: DetachedSignature;
  decisionDigest: string;
  projection: ToolDecisionProjection;
}

export interface SignedToolGrant {
  authorization: DetachedSignature;
  grantDigest: string;
  projection: ToolGrantProjection;
}

export interface SignedToolResult {
  authorization: DetachedSignature;
  projection: ToolResultProjection;
  resultDigest: string;
}

export interface RecoveredToolResultLineage {
  decision: SignedToolDecision;
  grant: SignedToolGrant;
  proposal: SignedToolProposal;
  result: SignedToolResult;
}

export type RecoveryCollectionName =
  | 'activeGrants'
  | 'decisions'
  | 'operations'
  | 'pendingProposals'
  | 'results';

export interface RecoveryCollectionBoundary {
  collectionDigest: string;
  itemCount: number;
}

export type RecoveryCollectionBoundaries = Readonly<Record<
  RecoveryCollectionName,
  RecoveryCollectionBoundary
>>;

export interface SnapshotCursorSigningProjection {
  collection: RecoveryCollectionName;
  collectionDigest: string;
  expiresAt: string;
  nextOffset: number;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  snapshotId: string;
  snapshotVersion: number;
  tenantId: string;
}

export interface SignedSnapshotCursor {
  authorization: DetachedSignature;
  projection: SnapshotCursorSigningProjection;
}

export interface SnapshotCursorContext {
  collection: RecoveryCollectionName;
  collectionDigest: string;
  expectedOffset: number;
  sessionId: string;
  snapshotExpiresAt: string;
  snapshotId: string;
  snapshotVersion: number;
  tenantId: string;
}

export interface SnapshotPage {
  collection: RecoveryCollectionName;
  collectionBoundaries: RecoveryCollectionBoundaries;
  createdAt: string;
  eventHead: EventHead;
  items: readonly unknown[];
  nextCursor: null | string;
  pageStart: number;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  snapshotCreatedAt: string;
  snapshotExpiresAt: string;
  snapshotId: string;
  snapshotVersion: number;
  state: string;
  tenantId: string;
  updatedAt: string;
}

export interface SnapshotCollectionContext {
  collection: RecoveryCollectionName;
  collectionBoundaries: RecoveryCollectionBoundaries;
  createdAt: string;
  eventHead: EventHead;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  snapshotCreatedAt: string;
  snapshotExpiresAt: string;
  snapshotId: string;
  snapshotVersion: number;
  state: string;
  tenantId: string;
  updatedAt: string;
}

export interface SnapshotPageContext extends SnapshotCollectionContext {
  expectedPageStart: number;
}

export interface SignedEventEnvelope extends EventProjection {
  authorization: DetachedSignature;
  eventHash: string;
  payload: JsonValue;
}

export interface EventHead {
  cursor: number;
  eventHash: null | string;
}

export interface EventVerificationOptions {
  expectedHead: EventHead;
  expectedSessionId: string;
  expectedTenantId: string;
  serverSigningKeys: readonly ServerEventSigningKey[];
  validateEnvelope: (envelope: SignedEventEnvelope) => boolean;
}

export class ProtocolSigningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolSigningError';
  }
}

function fail(code: string, message: string): never {
  throw new ProtocolSigningError(code, message);
}

function assertDigest(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) fail('invalid_digest', `${label} must be a lowercase SHA-256 digest`);
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) fail('invalid_uuid', `${label} must be a lowercase RFC 9562 UUID`);
}

function parseTimestamp(value: string, label: string): number {
  if (!DATE_TIME_PATTERN.test(value)) fail('invalid_timestamp', `${label} must use millisecond UTC date-time form`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('invalid_timestamp', `${label} is not a real calendar date-time`);
  }

  return milliseconds;
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value)
    .replaceAll(/[!'()*]/g, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
    .replaceAll(/%[\da-f]{2}/gi, (escape) => escape.toUpperCase());
}

function strictDecode(value: string, label: string): string {
  if (value.includes('+')) fail('ambiguous_url', `${label} must not use plus as a space encoding`);
  try {
    return decodeURIComponent(value);
  } catch {
    fail('ambiguous_url', `${label} contains malformed percent encoding`);
  }
}

export function normalizeCanonicalPath(path: string): string {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    fail('ambiguous_path', 'path must be an absolute path without query, fragment, or backslash');
  }

  const hasControlCharacter = [...path].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1F || codePoint === 0x7F;
  });
  if (hasControlCharacter || /%2f|%5c|%00/i.test(path)) {
    fail('ambiguous_path', 'path contains a forbidden encoded separator or control character');
  }

  const segments = path.split('/');
  if (segments.slice(1, -1).some((segment) => segment.length === 0)) {
    fail('ambiguous_path', 'path must not contain repeated separators');
  }

  const normalized = segments.map((segment, index) => {
    if (index === 0) return '';
    const decoded = strictDecode(segment, 'path segment');
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      fail('ambiguous_path', 'path must not contain dot or encoded separator segments');
    }

    return rfc3986Encode(decoded);
  }).join('/');
  return normalized || '/';
}

export function canonicalizeQuery(query: string): string {
  const source = query.startsWith('?') ? query.slice(1) : query;
  if (!source) return '';
  const pairs = source.split('&').map((part) => {
    if (!part) fail('ambiguous_query', 'query must not contain empty parameters');
    const separator = part.indexOf('=');
    if (separator === -1) fail('ambiguous_query', 'every query parameter must contain an equals sign');
    const name = rfc3986Encode(strictDecode(part.slice(0, separator), 'query name'));
    const value = rfc3986Encode(strictDecode(part.slice(separator + 1), 'query value'));
    return [name, value] as const;
  });

  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  });
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

export function decodeBase64Url(value: string, expectedBytes: number, label: string): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.includes('=')) {
    fail('invalid_base64url', `${label} must be unpadded base64url`);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    fail('invalid_base64url', `${label} must encode exactly ${expectedBytes} bytes`);
  }

  return decoded;
}

export function accessTokenDigest(token = ''): string {
  if (!/^[\u0020-\u007E]*$/.test(token)) {
    fail('invalid_token', 'access token must contain only printable ASCII bytes');
  }

  return sha256Bytes(Buffer.from(token, 'ascii'));
}

export function bodyDigest(body?: JsonValue): string {
  return body === undefined ? EMPTY_BODY_SHA256 : digestCanonicalJson(body);
}

export function publicKeyFromSeed(seed: string): string {
  const seedBytes = decodeBase64Url(seed, 32, 'private seed');
  const privateKey = createPrivateKey({
    format: 'der',
    key: Buffer.concat([PRIVATE_KEY_PREFIX, seedBytes]),
    type: 'pkcs8',
  });
  const publicDer = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
  return Buffer.from(publicDer).subarray(PUBLIC_KEY_PREFIX.length).toString('base64url');
}

export function keyThumbprint(publicKey: string): string {
  decodeBase64Url(publicKey, 32, 'public key');
  const jwk = {crv: 'Ed25519', kty: 'OKP', x: publicKey};
  return createHash('sha256').update(canonicalizeJson(jwk), 'utf8').digest('base64url');
}

export function validateServerEventSigningKeys(
  keys: readonly ServerEventSigningKey[],
): void {
  if (keys.length === 0 || keys.length > 8) {
    fail('invalid_event_key', 'between one and eight server event-signing keys are required');
  }

  const keyIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (const key of keys) {
    if (key.algorithm !== 'Ed25519') fail('invalid_event_key', 'server event key must use Ed25519');
    assertUuid(key.keyId, 'server event keyId');
    decodeBase64Url(key.publicKey, 32, 'server event public key');
    assertEqual(key.keyThumbprint, keyThumbprint(key.publicKey), 'server event key thumbprint');
    const validFrom = parseTimestamp(key.validFrom, 'server event key validFrom');
    const validUntil = parseTimestamp(key.validUntil, 'server event key validUntil');
    const retainUntil = parseTimestamp(key.retainUntil, 'server event key retainUntil');
    if (validFrom >= validUntil || validUntil >= retainUntil) {
      fail('invalid_event_key', 'server event key validity and retention windows are inconsistent');
    }

    if (keyIds.has(key.keyId) || publicKeys.has(key.publicKey)) {
      fail('invalid_event_key', 'server event-signing key IDs and material must be distinct');
    }

    keyIds.add(key.keyId);
    publicKeys.add(key.publicKey);
  }
}

export function resolveServerToolSigningAuthorities(
  keys: readonly ServerToolSigningKey[],
): Pick<ToolLifecycleAuthorities, 'grant' | 'proposal'> {
  if (keys.length !== 2) {
    fail('invalid_tool_authority', 'exactly one proposal key and one grant key are required');
  }

  const authorities = new Map<ServerToolSigningKey['role'], SigningAuthority>();
  const keyIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (const key of keys) {
    if (key.algorithm !== 'Ed25519' || (key.role !== 'proposal' && key.role !== 'grant')) {
      fail('invalid_tool_authority', 'unsupported server tool-signing algorithm or role');
    }

    assertUuid(key.keyId, 'server tool-signing key ID');
    decodeBase64Url(key.publicKey, 32, 'server tool-signing public key');
    if (key.keyThumbprint !== keyThumbprint(key.publicKey)) {
      fail('invalid_tool_authority', 'server tool-signing key thumbprint mismatch');
    }

    if (authorities.has(key.role)) {
      fail('invalid_tool_authority', `duplicate ${key.role} tool-signing role`);
    }

    if (keyIds.has(key.keyId) || publicKeys.has(key.publicKey)) {
      fail('invalid_tool_authority', 'server tool-signing key IDs and material must be distinct');
    }

    keyIds.add(key.keyId);
    publicKeys.add(key.publicKey);
    authorities.set(key.role, {expectedKeyId: key.keyId, publicKey: key.publicKey});
  }

  const proposal = authorities.get('proposal');
  const grant = authorities.get('grant');
  if (!proposal || !grant) {
    fail('invalid_tool_authority', 'proposal and grant tool-signing roles are both required');
  }

  return {grant, proposal};
}

export function createKeyRotationProjection(
  input: Omit<KeyRotationProjection, 'protocolVersion'>,
): KeyRotationProjection {
  for (const [label, value] of [
    ['tenantId', input.tenantId],
    ['deviceId', input.deviceId],
    ['currentKeyId', input.currentKeyId],
    ['newKeyId', input.newKeyId],
  ] as const) {
    assertUuid(value, label);
  }

  if (input.currentKeyId === input.newKeyId) {
    fail('invalid_key_rotation', 'newKeyId must differ from currentKeyId');
  }

  decodeBase64Url(input.newPublicKey, 32, 'new public key');
  assertEqual(input.newKeyThumbprint, keyThumbprint(input.newPublicKey), 'new key thumbprint');
  return {...input, protocolVersion: PROTOCOL_VERSION};
}

export function verifyKeyRotationRequest(
  request: RotateKeyRequest,
  expected: {
    currentKeyId: string;
    deviceId: string;
    tenantId: string;
  },
): void {
  const canonicalProjection = createKeyRotationProjection({
    currentKeyId: request.projection.currentKeyId,
    deviceId: request.projection.deviceId,
    newKeyId: request.projection.newKeyId,
    newKeyThumbprint: request.projection.newKeyThumbprint,
    newPublicKey: request.projection.newPublicKey,
    tenantId: request.projection.tenantId,
  });
  if (canonicalizeJson(canonicalProjection) !== canonicalizeJson(request.projection)) {
    fail('invalid_key_rotation', 'key rotation projection contains unsupported or altered fields');
  }

  assertEqual(request.projection.tenantId, expected.tenantId, 'rotation tenantId');
  assertEqual(request.projection.deviceId, expected.deviceId, 'rotation deviceId');
  assertEqual(request.projection.currentKeyId, expected.currentKeyId, 'rotation currentKeyId');
  assertEqual(request.newKeyProof.keyId, request.projection.newKeyId, 'new-key proof keyId');
  assertAuthorization(
    KEY_ROTATION_DOMAIN,
    request.projection,
    request.newKeyProof,
    request.projection.newPublicKey,
    request.projection.newKeyId,
  );
}

export function projectionBytes(domain: string, projection: unknown): Buffer {
  if (!/^[a-z0-9/-]+$/.test(domain)) fail('invalid_domain', 'signature domain is invalid');
  return Buffer.from(`${domain}\n${canonicalizeJson(projection)}`, 'utf8');
}

export function signProjection(domain: string, projection: unknown, privateSeed: string): string {
  const seed = decodeBase64Url(privateSeed, 32, 'private seed');
  const key = createPrivateKey({
    format: 'der',
    key: Buffer.concat([PRIVATE_KEY_PREFIX, seed]),
    type: 'pkcs8',
  });
  return signBytes(null, projectionBytes(domain, projection), key).toString('base64url');
}

export function verifyProjection(
  domain: string,
  projection: unknown,
  signature: string,
  publicKey: string,
): boolean {
  const signatureBytes = decodeBase64Url(signature, 64, 'signature');
  const publicBytes = decodeBase64Url(publicKey, 32, 'public key');
  const key = createPublicKey({
    format: 'der',
    key: Buffer.concat([PUBLIC_KEY_PREFIX, publicBytes]),
    type: 'spki',
  });
  return verifyBytes(null, projectionBytes(domain, projection), key, signatureBytes);
}

export function createRequestProjection(input: RequestProjectionInput): RequestSigningProjection {
  const method = input.method.toUpperCase();
  if (!['DELETE', 'GET', 'PATCH', 'POST', 'PUT'].includes(method)) {
    fail('invalid_method', 'unsupported HTTP method');
  }

  assertUuid(input.tenantId, 'tenantId');
  assertUuid(input.deviceId, 'deviceId');
  assertUuid(input.keyId, 'keyId');
  assertUuid(input.requestId, 'requestId');
  if (input.sessionId) assertUuid(input.sessionId, 'sessionId');
  if (input.idempotencyKey) assertUuid(input.idempotencyKey, 'idempotencyKey');
  if (!BASE64URL_PATTERN.test(input.nonce)) fail('invalid_nonce', 'nonce must be unpadded base64url');
  const nonceBytes = Buffer.from(input.nonce, 'base64url');
  if (
    nonceBytes.length < 16 ||
    nonceBytes.length > 64 ||
    nonceBytes.toString('base64url') !== input.nonce
  ) {
    fail('invalid_nonce', 'nonce must encode between 16 and 64 bytes');
  }

  parseTimestamp(input.timestamp, 'timestamp');
  const mediaType = input.bodyMediaType ?? (input.body === undefined ? 'none' : 'application/json');
  if ((input.body === undefined) !== (mediaType === 'none')) {
    fail('body_media_type_mismatch', 'bodyMediaType must be none exactly when the body is absent');
  }

  return {
    accessTokenDigest: accessTokenDigest(input.accessToken),
    bodyDigest: bodyDigest(input.body),
    bodyMediaType: mediaType,
    canonicalPath: normalizeCanonicalPath(input.path),
    canonicalQuery: canonicalizeQuery(input.query ?? ''),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? null,
    keyId: input.keyId,
    method: method as RequestSigningProjection['method'],
    nonce: input.nonce,
    protocolVersion: PROTOCOL_VERSION,
    requestId: input.requestId,
    sessionId: input.sessionId ?? null,
    tenantId: input.tenantId,
    timestamp: input.timestamp,
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail('binding_mismatch', `${label} does not match the signed projection`);
}

// Every signed transport binding is checked in one fail-closed verification path.
// eslint-disable-next-line complexity
export function verifyBoundRequest(
  projection: RequestSigningProjection,
  signature: string,
  context: RequestBindingContext,
  options: {
    committedOperation?: CommittedRequestIdentity;
    consumeNonce?: (tenantId: string, deviceId: string, nonce: string) => boolean;
    isKeyRevoked?: (tenantId: string, deviceId: string, keyId: string) => boolean;
    maxClockSkewMs?: number;
    now?: number;
  } = {},
): void {
  const expected = createRequestProjection(context);
  if (canonicalizeJson(projection) !== canonicalizeJson(expected)) {
    fail('binding_mismatch', 'signed request projection does not match the HTTP request');
  }

  if (context.path !== projection.canonicalPath || (context.query ?? '').replace(/^\?/, '') !== projection.canonicalQuery) {
    fail('noncanonical_url', 'wire path and query must already equal their canonical forms');
  }

  const idempotentReplay = options.committedOperation !== undefined;
  if (options.committedOperation) {
    assertIdenticalIdempotentRetry(
      options.committedOperation,
      createIdempotentRequestIdentity(projection),
    );
  }

  const now = options.now ?? Date.now();
  const timestamp = parseTimestamp(projection.timestamp, 'timestamp');
  if (!idempotentReplay && Math.abs(now - timestamp) > (options.maxClockSkewMs ?? 300_000)) {
    fail('stale_request', 'request timestamp is outside the permitted clock skew');
  }

  const isCommittedKeyMutationReplay =
    idempotentReplay &&
    projection.method === 'POST' &&
    (
      (
        options.committedOperation?.kind === 'key.rotate' &&
        projection.canonicalPath === '/v1/keys/rotate'
      ) ||
      (
        options.committedOperation?.kind === 'key.revoke' &&
        projection.canonicalPath === '/v1/keys/revoke'
      )
    );
  const isEnrollmentRequest =
    projection.method === 'POST' &&
    projection.canonicalPath === '/v1/enrollments';
  if (!isEnrollmentRequest && !options.isKeyRevoked) {
    fail(
      'revocation_store_unavailable',
      'protected requests require an authoritative key revocation lookup',
    );
  }

  if (
    options.isKeyRevoked?.(projection.tenantId, projection.deviceId, projection.keyId) &&
    !isCommittedKeyMutationReplay
  ) {
    fail('revoked_key', 'the enrollment-pinned key has been revoked');
  }

  if (isEnrollmentRequest) {
    if (context.accessToken || context.tokenClaims) {
      fail('unexpected_access_token', 'enrollment uses bootstrap provenance instead of bound access credentials');
    }

    if (!context.body || Array.isArray(context.body) || typeof context.body !== 'object') {
      fail('invalid_request', 'enrollment requires a complete EnrollmentRequest object');
    }

    const enrollment = context.body as Record<string, JsonValue>;
    for (const name of [
      'bootstrapToken',
      'deviceId',
      'deviceLabel',
      'keyId',
      'protocolVersion',
      'tenantId',
    ] as const) {
      if (typeof enrollment[name] !== 'string') {
        fail('invalid_request', `enrollment ${name} is required`);
      }
    }

    const enrollmentPublicKey = enrollment.publicKey;
    const enrollmentKeyThumbprint = enrollment.keyThumbprint;
    if (typeof enrollmentPublicKey !== 'string' || typeof enrollmentKeyThumbprint !== 'string') {
      fail('invalid_request', 'enrollment publicKey and keyThumbprint are required');
    }

    if (
      !enrollment.clientCapabilities ||
      Array.isArray(enrollment.clientCapabilities) ||
      typeof enrollment.clientCapabilities !== 'object'
    ) {
      fail('invalid_request', 'enrollment clientCapabilities is required');
    }

    assertEqual(context.publicKey, enrollmentPublicKey, 'enrollment publicKey');
    assertEqual(
      enrollmentKeyThumbprint,
      keyThumbprint(enrollmentPublicKey),
      'enrollment keyThumbprint',
    );
  } else {
    if (!context.accessToken) fail('missing_access_token', 'protected requests require the exact access token');
    if (!context.tokenClaims) fail('missing_token_claims', 'protected requests require bound token claims');
    assertEqual(context.tokenClaims.tenantId, projection.tenantId, 'token tenantId');
    assertEqual(context.tokenClaims.deviceId, projection.deviceId, 'token deviceId');
    assertEqual(context.tokenClaims.keyId, projection.keyId, 'token keyId');
    assertEqual(context.tokenClaims.cnf.jkt, keyThumbprint(context.publicKey), 'token key thumbprint');
    const issuedAt = parseTimestamp(context.tokenClaims.issuedAt, 'token issuedAt');
    const expiresAt = parseTimestamp(context.tokenClaims.expiresAt, 'token expiresAt');
    if (issuedAt >= expiresAt) fail('invalid_token', 'access token expiry must be after its issue time');
    const isRefreshRequest =
      projection.method === 'POST' &&
      projection.canonicalPath === '/v1/auth/refresh';
    if (!idempotentReplay && !isRefreshRequest && expiresAt <= now) {
      fail('expired_token', 'access token has expired');
    }

    if (issuedAt > now + (options.maxClockSkewMs ?? 300_000)) {
      fail('invalid_token', 'access token issue time is in the future');
    }
  }

  for (const [name, value] of Object.entries(context.bodyIds ?? {})) {
    if (value !== undefined) assertEqual(value, projection[name as keyof RequestSigningProjection], `body ${name}`);
  }

  if (context.body && !Array.isArray(context.body) && typeof context.body === 'object') {
    const body = context.body as Record<string, JsonValue>;
    const nestedProjection = body.projection;
    const bindings = [
      body,
      nestedProjection && !Array.isArray(nestedProjection) && typeof nestedProjection === 'object'
        ? nestedProjection as Record<string, JsonValue>
        : undefined,
    ].filter((value): value is Record<string, JsonValue> => value !== undefined);
    for (const candidate of bindings) {
      if (typeof candidate.protocolVersion === 'string') {
        assertEqual(candidate.protocolVersion, PROTOCOL_VERSION, 'body protocolVersion');
      }

      for (const name of ['deviceId', 'keyId', 'requestId', 'sessionId', 'tenantId'] as const) {
        if (typeof candidate[name] === 'string') assertEqual(candidate[name], projection[name], `body ${name}`);
      }
    }
  }

  if (!verifyProjection(
    REQUEST_SIGNATURE_DOMAIN,
    projection,
    signature,
    context.publicKey,
  )) {
    fail('invalid_signature', 'request signature is invalid');
  }

  if (!idempotentReplay) {
    if (!options.consumeNonce) {
      fail('nonce_store_unavailable', 'fresh requests require atomic durable nonce consumption');
    }

    if (!options.consumeNonce(projection.tenantId, projection.deviceId, projection.nonce)) {
      fail('nonce_reuse', 'request nonce has already been used');
    }
  }
}

export function digestProjection(domain: string, projection: unknown): string {
  return sha256Bytes(projectionBytes(domain, projection));
}

export function createToolDescriptorProjection(
  descriptor: Omit<ToolDescriptorProjection, 'protocolVersion' | 'schemaDigest'>,
): ToolDescriptorProjection {
  return {
    ...descriptor,
    protocolVersion: PROTOCOL_VERSION,
    schemaDigest: digestCanonicalJson(descriptor.inputSchema),
  };
}

export function toolDescriptorDigest(projection: ToolDescriptorProjection): string {
  assertDigest(projection.schemaDigest, 'schemaDigest');
  return digestProjection(TOOL_DESCRIPTOR_DOMAIN, projection);
}

export function toolProposalDigest(projection: ToolProposalProjection): string {
  assertDigest(projection.argumentsDigest, 'argumentsDigest');
  assertDigest(projection.descriptorDigest, 'descriptorDigest');
  return digestProjection(TOOL_PROPOSAL_DOMAIN, projection);
}

export function toolDecisionDigest(projection: ToolDecisionProjection): string {
  assertDigest(projection.proposalDigest, 'proposalDigest');
  return digestProjection(TOOL_DECISION_DOMAIN, projection);
}

export function toolGrantDigest(projection: ToolGrantProjection): string {
  if (projection.decision !== 'approved') fail('invalid_grant', 'a grant requires an approved decision');
  assertDigest(projection.proposalDigest, 'proposalDigest');
  assertDigest(projection.decisionDigest, 'decisionDigest');
  return digestProjection(TOOL_GRANT_DOMAIN, projection);
}

export function toolResultDigest(projection: ToolResultProjection): string {
  for (const [label, digest] of [
    ['proposalDigest', projection.proposalDigest],
    ['decisionDigest', projection.decisionDigest],
    ['grantDigest', projection.grantDigest],
    ['outputDigest', projection.outputDigest],
    ['evidenceDigest', projection.evidenceDigest],
  ]) {
    assertDigest(digest, label);
  }

  if (projection.errorDigest) assertDigest(projection.errorDigest, 'errorDigest');
  return digestProjection(TOOL_RESULT_DOMAIN, projection);
}

export function createEventProjection(input: Omit<EventProjection, 'payloadDigest' | 'protocolVersion'> & {
  payload: JsonValue;
}): EventProjection {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    fail('invalid_sequence', 'event sequence must be a positive safe integer');
  }

  if (!Number.isSafeInteger(input.cursor) || input.cursor !== input.sequence) {
    fail('invalid_cursor', 'event cursor must equal event sequence');
  }

  if (input.previousEventHash) assertDigest(input.previousEventHash, 'previousEventHash');
  assertUuid(input.tenantId, 'tenantId');
  assertUuid(input.sessionId, 'sessionId');
  assertUuid(input.eventId, 'eventId');
  parseTimestamp(input.occurredAt, 'occurredAt');
  return {
    cursor: input.cursor,
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    payloadDigest: digestCanonicalJson(input.payload),
    previousEventHash: input.previousEventHash,
    protocolVersion: PROTOCOL_VERSION,
    sequence: input.sequence,
    sessionId: input.sessionId,
    tenantId: input.tenantId,
  };
}

export function eventHash(projection: EventProjection): string {
  return digestProjection(EVENT_ENVELOPE_DOMAIN, projection);
}

export function requestProjectionDigest(projection: RequestSigningProjection): string {
  return digestProjection(REQUEST_SIGNATURE_DOMAIN, projection);
}

export function createIdempotentRequestIdentity(
  projection: RequestSigningProjection,
): IdempotentRequestIdentity {
  if (!projection.idempotencyKey) {
    fail('missing_idempotency_key', 'the signed request projection has no idempotency key');
  }

  return {
    deviceId: projection.deviceId,
    idempotencyKey: projection.idempotencyKey,
    requestDigest: requestProjectionDigest(projection),
    requestId: projection.requestId,
    tenantId: projection.tenantId,
  };
}

export function assertIdenticalIdempotentRetry(
  existing: IdempotentRequestIdentity,
  candidate: IdempotentRequestIdentity,
): void {
  for (const name of ['tenantId', 'deviceId', 'requestId', 'idempotencyKey', 'requestDigest'] as const) {
    if (existing[name] !== candidate[name]) {
      fail('idempotency_conflict', `${name} differs from the durably committed operation`);
    }
  }
}

// eslint-disable-next-line max-params
function assertAuthorization(
  domain: string,
  projection: unknown,
  authorization: DetachedSignature,
  publicKey: string,
  expectedKeyId?: string,
): void {
  if (authorization.algorithm !== 'Ed25519') fail('invalid_signature', 'signature algorithm must be Ed25519');
  assertUuid(authorization.keyId, 'authorization keyId');
  if (expectedKeyId) assertEqual(authorization.keyId, expectedKeyId, 'authorization keyId');
  if (!verifyProjection(domain, projection, authorization.signature, publicKey)) {
    fail('invalid_signature', 'detached projection signature is invalid');
  }
}

function assertProjectionChain(
  left: {projection: {proposalDigest?: string; proposalId: string; sessionId: string; tenantId: string}},
  right: {projection: {proposalDigest?: string; proposalId: string; sessionId: string; tenantId: string}},
): void {
  for (const name of ['tenantId', 'sessionId', 'proposalId'] as const) {
    assertEqual(right.projection[name], left.projection[name], `tool lifecycle ${name}`);
  }

  if (left.projection.proposalDigest) {
    assertEqual(right.projection.proposalDigest, left.projection.proposalDigest, 'tool lifecycle proposalDigest');
  }
}

type ToolInputSchema = Record<string, JsonValue>;

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSchemaKeys(schema: ToolInputSchema, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(schema).find((key) => !allowedKeys.has(key));
  if (unknown) fail('invalid_tool_schema', `unsupported tool input schema keyword: ${unknown}`);
}

function assertOptionalBoundedInteger(
  schema: ToolInputSchema,
  key: string,
  maximum: number,
): number | undefined {
  const value = schema[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail('invalid_tool_schema', `${key} must be a nonnegative bounded safe integer`);
  }

  return value as number;
}

// The validator deliberately handles each closed tool-schema variant in one bounded iterative pass.
// eslint-disable-next-line complexity
export function assertSupportedToolInputSchema(inputSchema: JsonValue): void {
  canonicalizeJson(inputSchema);
  const pending: JsonValue[] = [inputSchema];
  let nodes = 0;
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    nodes += 1;
    if (nodes > 1024 || !isJsonObject(candidate)) {
      fail('invalid_tool_schema', 'tool input schema exceeds limits or contains a non-object node');
    }

    const schema = candidate as ToolInputSchema;
    const type = schema.type;
    if (typeof type !== 'string') {
      fail('invalid_tool_schema', 'every tool input schema node requires one supported type');
    }

    switch (type) {
      case 'array': {
        assertSchemaKeys(schema, ['items', 'maxItems', 'minItems', 'type']);
        if (!isJsonObject(schema.items as JsonValue)) {
          fail('invalid_tool_schema', 'array tool schemas require an items schema');
        }

        const maxItems = assertOptionalBoundedInteger(schema, 'maxItems', 1024);
        const minItems = assertOptionalBoundedInteger(schema, 'minItems', 1024) ?? 0;
        if (maxItems === undefined || minItems > maxItems) {
          fail('invalid_tool_schema', 'array schemas require maxItems greater than or equal to minItems');
        }

        pending.push(schema.items as JsonValue);
        break;
      }

      case 'boolean':
      case 'null': {
        assertSchemaKeys(schema, ['type']);
        break;
      }

      case 'integer':
      case 'number': {
        assertSchemaKeys(schema, ['maximum', 'minimum', 'type']);
        const minimum = schema.minimum;
        const maximum = schema.maximum;
        if (minimum !== undefined && typeof minimum !== 'number') {
          fail('invalid_tool_schema', 'minimum must be a finite JSON number');
        }

        if (maximum !== undefined && typeof maximum !== 'number') {
          fail('invalid_tool_schema', 'maximum must be a finite JSON number');
        }

        if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum) {
          fail('invalid_tool_schema', 'minimum must not exceed maximum');
        }

        break;
      }

      case 'object': {
        assertSchemaKeys(schema, ['additionalProperties', 'maxProperties', 'properties', 'required', 'type']);
        if (schema.additionalProperties !== false || !isJsonObject(schema.properties as JsonValue)) {
          fail(
            'invalid_tool_schema',
            'object tool schemas require properties and additionalProperties false',
          );
        }

        const properties = schema.properties as Record<string, JsonValue>;
        const propertyNames = Object.keys(properties);
        if (propertyNames.length > 256
          || propertyNames.some((name) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name))) {
          fail('invalid_tool_schema', 'tool schema property names or count exceed protocol limits');
        }

        const maxProperties = assertOptionalBoundedInteger(schema, 'maxProperties', 256);
        if (maxProperties === undefined || maxProperties < propertyNames.length) {
          fail('invalid_tool_schema', 'object schemas require a sufficient bounded maxProperties');
        }

        const required = schema.required;
        if (!Array.isArray(required)
          || required.length > 256
          || required.some((name) => typeof name !== 'string' || !Object.hasOwn(properties, name))
          || new Set(required).size !== required.length) {
          fail('invalid_tool_schema', 'required must uniquely reference declared properties');
        }

        pending.push(...Object.values(properties));
        break;
      }

      case 'string': {
        assertSchemaKeys(schema, ['maxLength', 'minLength', 'type']);
        const maxLength = assertOptionalBoundedInteger(schema, 'maxLength', 65_536);
        const minLength = assertOptionalBoundedInteger(schema, 'minLength', 65_536) ?? 0;
        if (maxLength === undefined || minLength > maxLength) {
          fail('invalid_tool_schema', 'string schemas require maxLength greater than or equal to minLength');
        }

        break;
      }

      default: {
        fail('invalid_tool_schema', `unsupported tool input schema type: ${type}`);
      }
    }
  }
}

// Argument validation mirrors every schema variant without delegating authority to a permissive validator.
// eslint-disable-next-line complexity
export function assertToolArguments(inputSchema: JsonValue, argumentsValue: JsonValue): void {
  assertSupportedToolInputSchema(inputSchema);
  canonicalizeJson(argumentsValue);
  const pending: Array<{schema: ToolInputSchema; value: JsonValue}> = [{
    schema: inputSchema as ToolInputSchema,
    value: argumentsValue,
  }];
  let nodes = 0;
  while (pending.length > 0) {
    const {schema, value} = pending.pop()!;
    nodes += 1;
    if (nodes > 10_000) fail('invalid_tool_arguments', 'tool arguments exceed the node limit');
    switch (schema.type) {
      case 'array': {
        if (!Array.isArray(value)) fail('invalid_tool_arguments', 'tool argument must be an array');
        const minItems = (schema.minItems as number | undefined) ?? 0;
        if (value.length < minItems || value.length > (schema.maxItems as number)) {
          fail('invalid_tool_arguments', 'tool argument array length is outside allowed limits');
        }

        for (const item of value) {
          pending.push({schema: schema.items as ToolInputSchema, value: item});
        }

        break;
      }

      case 'boolean': {
        if (typeof value !== 'boolean') fail('invalid_tool_arguments', 'tool argument must be boolean');
        break;
      }

      case 'integer': {
        if (!Number.isSafeInteger(value)) fail('invalid_tool_arguments', 'tool argument must be a safe integer');
        if ((schema.minimum !== undefined && (value as number) < (schema.minimum as number))
          || (schema.maximum !== undefined && (value as number) > (schema.maximum as number))) {
          fail('invalid_tool_arguments', 'tool integer argument is outside allowed bounds');
        }

        break;
      }

      case 'null': {
        if (value !== null) fail('invalid_tool_arguments', 'tool argument must be null');
        break;
      }

      case 'number': {
        if (typeof value !== 'number') fail('invalid_tool_arguments', 'tool argument must be a number');
        if ((schema.minimum !== undefined && value < (schema.minimum as number))
          || (schema.maximum !== undefined && value > (schema.maximum as number))) {
          fail('invalid_tool_arguments', 'tool number argument is outside allowed bounds');
        }

        break;
      }

      case 'object': {
        if (!isJsonObject(value)) fail('invalid_tool_arguments', 'tool argument must be an object');
        const properties = schema.properties as Record<string, ToolInputSchema>;
        const required = schema.required as string[];
        if (Object.keys(value).length > (schema.maxProperties as number)
          || Object.keys(value).some((name) => !Object.hasOwn(properties, name))
          || required.some((name) => !Object.hasOwn(value, name))) {
          fail('invalid_tool_arguments', 'tool argument object violates its closed property contract');
        }

        for (const [name, propertyValue] of Object.entries(value)) {
          pending.push({schema: properties[name]!, value: propertyValue});
        }

        break;
      }

      case 'string': {
        if (typeof value !== 'string') fail('invalid_tool_arguments', 'tool argument must be a string');
        const minLength = (schema.minLength as number | undefined) ?? 0;
        const codePoints = [...value].length;
        if (codePoints < minLength || codePoints > (schema.maxLength as number)) {
          fail('invalid_tool_arguments', 'tool string argument length is outside allowed limits');
        }

        break;
      }

      default: {
        fail('invalid_tool_schema', 'tool input schema type changed after validation');
      }
    }
  }
}

export function verifyToolDescriptor(
  descriptor: SignedToolDescriptor,
  authority: SigningAuthority,
): void {
  assertSupportedToolInputSchema(descriptor.projection.inputSchema);
  if ((descriptor.projection.inputSchema as ToolInputSchema).type !== 'object') {
    fail('invalid_tool_schema', 'tool descriptor input schemas require an object root');
  }

  assertEqual(
    descriptor.projection.schemaDigest,
    digestCanonicalJson(descriptor.projection.inputSchema),
    'tool descriptor schemaDigest',
  );
  assertEqual(
    descriptor.descriptorDigest,
    toolDescriptorDigest(descriptor.projection),
    'tool descriptor digest',
  );
  assertAuthorization(
    TOOL_DESCRIPTOR_DOMAIN,
    descriptor.projection,
    descriptor.authorization,
    authority.publicKey,
    authority.expectedKeyId,
  );
}

export function verifyToolProposal(
  proposal: SignedToolProposal,
  descriptor: SignedToolDescriptor,
  authorities: Pick<ToolLifecycleAuthorities, 'descriptor' | 'proposal'>,
): void {
  verifyToolDescriptor(descriptor, authorities.descriptor);
  assertUuid(proposal.projection.proposalId, 'proposalId');
  parseTimestamp(proposal.projection.expiresAt, 'proposal expiresAt');
  assertEqual(proposal.projection.tenantId, descriptor.projection.tenantId, 'proposal tenantId');
  assertEqual(proposal.projection.toolName, descriptor.projection.name, 'proposal toolName');
  assertEqual(proposal.projection.descriptorDigest, descriptor.descriptorDigest, 'proposal descriptorDigest');
  assertEqual(
    proposal.projection.argumentsDigest,
    digestCanonicalJson(proposal.arguments),
    'proposal argumentsDigest',
  );
  assertToolArguments(descriptor.projection.inputSchema, proposal.arguments);
  assertEqual(proposal.proposalDigest, toolProposalDigest(proposal.projection), 'proposal digest');
  assertAuthorization(
    TOOL_PROPOSAL_DOMAIN,
    proposal.projection,
    proposal.authorization,
    authorities.proposal.publicKey,
    authorities.proposal.expectedKeyId,
  );
}

export function verifyToolDecision(
  decision: SignedToolDecision,
  proposal: SignedToolProposal,
  authorities: Pick<ToolLifecycleAuthorities, 'decision' | 'proposal'>,
): void {
  assertEqual(
    proposal.projection.argumentsDigest,
    digestCanonicalJson(proposal.arguments),
    'proposal argumentsDigest',
  );
  assertAuthorization(
    TOOL_PROPOSAL_DOMAIN,
    proposal.projection,
    proposal.authorization,
    authorities.proposal.publicKey,
    authorities.proposal.expectedKeyId,
  );
  assertUuid(decision.projection.decisionId, 'decisionId');
  assertEqual(proposal.proposalDigest, toolProposalDigest(proposal.projection), 'proposal digest');
  assertProjectionChain(proposal, decision);
  assertEqual(decision.projection.proposalDigest, proposal.proposalDigest, 'decision proposalDigest');
  const decidedAt = parseTimestamp(decision.projection.decidedAt, 'decision decidedAt');
  if (decidedAt > parseTimestamp(proposal.projection.expiresAt, 'proposal expiresAt')) {
    fail('expired_proposal', 'the decision was recorded after the proposal expired');
  }

  assertEqual(decision.decisionDigest, toolDecisionDigest(decision.projection), 'decision digest');
  assertAuthorization(
    TOOL_DECISION_DOMAIN,
    decision.projection,
    decision.authorization,
    authorities.decision.publicKey,
    authorities.decision.expectedKeyId,
  );
}

export function verifyToolGrant(
  grant: SignedToolGrant,
  proposal: SignedToolProposal,
  decision: SignedToolDecision,
  authorities: Pick<ToolLifecycleAuthorities, 'decision' | 'grant' | 'proposal'>,
): void {
  verifyToolDecision(decision, proposal, authorities);
  assertProjectionChain(proposal, grant);
  assertEqual(decision.projection.decision, 'approved', 'grant decision');
  assertEqual(grant.projection.decision, decision.projection.decision, 'grant decision');
  assertEqual(grant.projection.proposalDigest, proposal.proposalDigest, 'grant proposalDigest');
  assertEqual(grant.projection.decisionDigest, decision.decisionDigest, 'grant decisionDigest');
  assertUuid(grant.projection.grantId, 'grantId');
  const grantExpiry = parseTimestamp(grant.projection.expiresAt, 'grant expiresAt');
  if (grantExpiry <= parseTimestamp(decision.projection.decidedAt, 'decision decidedAt')) {
    fail('invalid_grant', 'grant expiry must be after the decision');
  }

  const nonce = Buffer.from(grant.projection.oneUseNonce, 'base64url');
  if (
    !BASE64URL_PATTERN.test(grant.projection.oneUseNonce) ||
    nonce.length < 16 ||
    nonce.length > 64 ||
    nonce.toString('base64url') !== grant.projection.oneUseNonce
  ) {
    fail('invalid_nonce', 'grant one-use nonce must encode between 16 and 64 bytes');
  }

  assertGrantLimits(proposal.projection.budgetEstimate, grant.projection.allowedLimits);
  assertEqual(grant.grantDigest, toolGrantDigest(grant.projection), 'grant digest');
  assertAuthorization(
    TOOL_GRANT_DOMAIN,
    grant.projection,
    grant.authorization,
    authorities.grant.publicKey,
    authorities.grant.expectedKeyId,
  );
}

function assertGrantLimits(budget: JsonValue, allowed: JsonValue): void {
  if (
    !budget ||
    !allowed ||
    Array.isArray(budget) ||
    Array.isArray(allowed) ||
    typeof budget !== 'object' ||
    typeof allowed !== 'object'
  ) {
    fail('invalid_grant', 'budget and allowed limits must be JSON objects');
  }

  const maxima = {
    networkRequests: 1024,
    outputBytes: 1_048_576,
    wallClockMs: 3_600_000,
  } as const;
  const names = Object.keys(maxima) as Array<keyof typeof maxima>;
  if (
    Object.keys(budget).length !== names.length
    || Object.keys(allowed).length !== names.length
    || Object.keys(budget).some((name) => !Object.hasOwn(maxima, name))
    || Object.keys(allowed).some((name) => !Object.hasOwn(maxima, name))
  ) {
    fail('invalid_grant', 'budget and allowed limits must use the closed limit contract');
  }

  for (const name of names) {
    const budgetValue = budget[name];
    const allowedValue = allowed[name];
    const minimum = name === 'wallClockMs' ? 1 : 0;
    if (
      !isValidGrantLimit(budgetValue, minimum, maxima[name]) ||
      !isValidGrantLimit(allowedValue, minimum, maxima[name]) ||
      allowedValue > budgetValue
    ) {
      fail('invalid_grant', `${name} violates the protocol maximum or proposed budget estimate`);
    }
  }
}

function isValidGrantLimit(value: JsonValue, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

// eslint-disable-next-line max-params
export function authorizeToolGrantExecution(
  grant: SignedToolGrant,
  proposal: SignedToolProposal,
  decision: SignedToolDecision,
  authorities: Pick<
    ToolLifecycleAuthorities,
    'decision' | 'descriptor' | 'grant' | 'proposal'
  >,
  options: {
    consumeGrant: (grantId: string, oneUseNonce: string) => boolean;
    descriptor: SignedToolDescriptor;
    now?: number;
  },
): void {
  verifyToolProposal(proposal, options.descriptor, authorities);
  verifyToolGrant(grant, proposal, decision, authorities);
  const now = options.now ?? Date.now();
  if (parseTimestamp(grant.projection.expiresAt, 'grant expiresAt') <= now) {
    fail('expired_grant', 'tool grant has expired');
  }

  if (!options.consumeGrant(grant.projection.grantId, grant.projection.oneUseNonce)) {
    fail('grant_reuse', 'tool grant was already consumed');
  }
}

// eslint-disable-next-line max-params
export function verifyToolResult(
  result: SignedToolResult,
  proposal: SignedToolProposal,
  decision: SignedToolDecision,
  grant: SignedToolGrant,
  authorities: Pick<
    ToolLifecycleAuthorities,
    'decision' | 'grant' | 'proposal' | 'result'
  >,
  options: {
    error?: JsonValue;
    evidence?: JsonValue;
    output?: JsonValue;
  } = {},
): void {
  verifyToolGrant(grant, proposal, decision, authorities);
  assertProjectionChain(proposal, result);
  assertEqual(result.projection.proposalDigest, proposal.proposalDigest, 'result proposalDigest');
  assertEqual(result.projection.decisionDigest, decision.decisionDigest, 'result decisionDigest');
  assertEqual(result.projection.grantId, grant.projection.grantId, 'result grantId');
  assertEqual(result.projection.grantDigest, grant.grantDigest, 'result grantDigest');
  assertUuid(result.projection.resultId, 'resultId');
  assertUuid(result.projection.executionLedgerId, 'executionLedgerId');
  parseTimestamp(result.projection.completedAt, 'result completedAt');
  if (options.output !== undefined) {
    assertEqual(result.projection.outputDigest, digestCanonicalJson(options.output), 'result outputDigest');
  }

  if (options.evidence !== undefined) {
    assertEqual(result.projection.evidenceDigest, digestCanonicalJson(options.evidence), 'result evidenceDigest');
  }

  if (options.error !== undefined) {
    assertEqual(result.projection.errorDigest, digestCanonicalJson(options.error), 'result errorDigest');
  }

  if (result.projection.status === 'succeeded' && result.projection.errorDigest !== null) {
    fail('invalid_result', 'a succeeded result cannot carry an error digest');
  }

  if (
    ['ambiguous', 'failed', 'timeout'].includes(result.projection.status) &&
    result.projection.errorDigest === null
  ) {
    fail('invalid_result', `${result.projection.status} results require an error digest`);
  }

  assertEqual(result.resultDigest, toolResultDigest(result.projection), 'result digest');
  assertAuthorization(
    TOOL_RESULT_DOMAIN,
    result.projection,
    result.authorization,
    authorities.result.publicKey,
    authorities.result.expectedKeyId,
  );
}

const SNAPSHOT_COLLECTIONS: readonly RecoveryCollectionName[] = [
  'activeGrants',
  'decisions',
  'operations',
  'pendingProposals',
  'results',
];

function cursorString(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    fail('snapshot_cursor_mismatch', `snapshot cursor ${key} must be a string`);
  }

  return value;
}

function assertSnapshotCursorStructure(
  value: JsonValue,
): asserts value is JsonValue & SignedSnapshotCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor must be an object');
  }

  const cursor = value as Record<string, JsonValue>;
  if (Object.keys(cursor).sort().join(',') !== 'authorization,projection') {
    fail('snapshot_cursor_mismatch', 'snapshot cursor contains unknown or missing fields');
  }

  const {authorization, projection} = cursor;
  if (
    typeof authorization !== 'object' ||
    authorization === null ||
    Array.isArray(authorization)
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor authorization must be an object');
  }

  const authorizationRecord = authorization as Record<string, JsonValue>;
  if (
    Object.keys(authorizationRecord).sort().join(',') !==
    'algorithm,keyId,signature'
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor authorization is malformed');
  }

  const algorithm = cursorString(authorizationRecord, 'algorithm');
  if (algorithm !== 'Ed25519') {
    fail('snapshot_cursor_mismatch', 'snapshot cursor algorithm must be Ed25519');
  }

  assertUuid(cursorString(authorizationRecord, 'keyId'), 'snapshot cursor keyId');
  decodeBase64Url(
    cursorString(authorizationRecord, 'signature'),
    64,
    'snapshot cursor signature',
  );

  if (
    typeof projection !== 'object' ||
    projection === null ||
    Array.isArray(projection)
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor projection must be an object');
  }

  const projectionRecord = projection as Record<string, JsonValue>;
  const projectionKeys = [
    'collection',
    'collectionDigest',
    'expiresAt',
    'nextOffset',
    'protocolVersion',
    'sessionId',
    'snapshotId',
    'snapshotVersion',
    'tenantId',
  ];
  if (
    Object.keys(projectionRecord).sort().join(',') !==
    projectionKeys.sort().join(',')
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor projection is malformed');
  }

  if (cursorString(projectionRecord, 'protocolVersion') !== PROTOCOL_VERSION) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor protocolVersion is invalid');
  }

  assertUuid(cursorString(projectionRecord, 'tenantId'), 'snapshot cursor tenantId');
  assertUuid(cursorString(projectionRecord, 'sessionId'), 'snapshot cursor sessionId');
  assertUuid(cursorString(projectionRecord, 'snapshotId'), 'snapshot cursor snapshotId');
  if (
    !Number.isSafeInteger(projectionRecord.snapshotVersion) ||
    Number(projectionRecord.snapshotVersion) < 1
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor snapshotVersion is invalid');
  }

  const collection = cursorString(projectionRecord, 'collection');
  if (!SNAPSHOT_COLLECTIONS.includes(collection as RecoveryCollectionName)) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor collection is invalid');
  }

  assertDigest(
    cursorString(projectionRecord, 'collectionDigest'),
    'snapshot cursor collectionDigest',
  );
  if (
    !Number.isSafeInteger(projectionRecord.nextOffset) ||
    Number(projectionRecord.nextOffset) < 1
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor nextOffset is invalid');
  }

  parseTimestamp(
    cursorString(projectionRecord, 'expiresAt'),
    'snapshot cursor expiresAt',
  );
}

export function createSnapshotCursor(
  projection: SnapshotCursorSigningProjection,
  keyId: string,
  privateSeed: string,
): SignedSnapshotCursor {
  const cursor: SignedSnapshotCursor = {
    authorization: {
      algorithm: 'Ed25519',
      keyId,
      signature: signProjection(SNAPSHOT_CURSOR_DOMAIN, projection, privateSeed),
    },
    projection,
  };
  assertSnapshotCursorStructure(parseStrictJson(canonicalizeJson(cursor)));
  return cursor;
}

export function encodeSnapshotCursor(cursor: SignedSnapshotCursor): string {
  return Buffer.from(canonicalizeJson(cursor), 'utf8').toString('base64url');
}

export function decodeSnapshotCursor(token: string): SignedSnapshotCursor {
  if (
    typeof token !== 'string' ||
    token.length < 128 ||
    token.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor token is malformed');
  }

  const decoded = Buffer.from(token, 'base64url');
  if (decoded.toString('base64url') !== token || decoded.length > 1536) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor token is not canonical base64url');
  }

  const json = decoded.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(decoded)) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor token is not valid UTF-8');
  }

  let value: JsonValue;
  try {
    value = parseStrictJson(json);
  } catch {
    fail('snapshot_cursor_mismatch', 'snapshot cursor token does not contain strict JSON');
  }

  assertSnapshotCursorStructure(value);
  if (canonicalizeJson(value) !== json) {
    fail('snapshot_cursor_mismatch', 'snapshot cursor token JSON is not canonical');
  }

  return value;
}

function snapshotCursorMismatch(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail('snapshot_cursor_mismatch', `${label} does not match the frozen snapshot`);
  }
}

export function verifySnapshotCursor(
  cursor: SignedSnapshotCursor,
  context: SnapshotCursorContext,
  authority: SigningAuthority,
  now: number = Date.now(),
): void {
  const validated = decodeSnapshotCursor(encodeSnapshotCursor(cursor));
  const {projection} = validated;
  snapshotCursorMismatch(projection.tenantId, context.tenantId, 'tenantId');
  snapshotCursorMismatch(projection.sessionId, context.sessionId, 'sessionId');
  snapshotCursorMismatch(projection.snapshotId, context.snapshotId, 'snapshotId');
  snapshotCursorMismatch(
    projection.snapshotVersion,
    context.snapshotVersion,
    'snapshotVersion',
  );
  snapshotCursorMismatch(projection.collection, context.collection, 'collection');
  snapshotCursorMismatch(
    projection.collectionDigest,
    context.collectionDigest,
    'collectionDigest',
  );
  snapshotCursorMismatch(projection.nextOffset, context.expectedOffset, 'nextOffset');
  snapshotCursorMismatch(
    projection.expiresAt,
    context.snapshotExpiresAt,
    'expiresAt',
  );
  if (now >= parseTimestamp(projection.expiresAt, 'snapshot cursor expiresAt')) {
    fail('snapshot_expired', 'snapshot cursor has expired; restart from a new snapshot');
  }

  assertAuthorization(
    SNAPSHOT_CURSOR_DOMAIN,
    validated.projection,
    validated.authorization,
    authority.publicKey,
    authority.expectedKeyId,
  );
}

function snapshotItemId(collection: RecoveryCollectionName, item: unknown): string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    fail('snapshot_integrity_failed', `${collection} item must be an object`);
  }

  const record = item as Record<string, unknown>;
  const projection =
    collection === 'operations'
      ? (record.operation as Record<string, unknown> | undefined)
      : collection === 'results'
        ? (record.result as Record<string, unknown> | undefined)?.projection
        : record.projection;
  if (typeof projection !== 'object' || projection === null || Array.isArray(projection)) {
    fail('snapshot_integrity_failed', `${collection} item projection is missing`);
  }

  const idFields: Record<RecoveryCollectionName, string> = {
    activeGrants: 'grantId',
    decisions: 'decisionId',
    operations: 'requestId',
    pendingProposals: 'proposalId',
    results: 'resultId',
  };
  const id = (projection as Record<string, unknown>)[idFields[collection]];
  if (typeof id !== 'string') {
    fail('snapshot_integrity_failed', `${collection} stable record identifier is missing`);
  }

  assertUuid(id, `${collection} stable record identifier`);
  return id;
}

function assertSnapshotItemScope(
  collection: RecoveryCollectionName,
  item: unknown,
  tenantId: string,
  sessionId: string,
): void {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    fail('snapshot_integrity_failed', `${collection} item must be an object`);
  }

  const record = item as Record<string, unknown>;
  const assertProjectionScope = (value: unknown, label: string): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail('snapshot_integrity_failed', `${label} is missing`);
    }

    const projection = (value as Record<string, unknown>).projection;
    if (typeof projection !== 'object' || projection === null || Array.isArray(projection)) {
      fail('snapshot_integrity_failed', `${label} projection is missing`);
    }

    const fields = projection as Record<string, unknown>;
    if (fields.tenantId !== tenantId || fields.sessionId !== sessionId) {
      fail('snapshot_integrity_failed', `${label} belongs to a different tenant or session`);
    }
  };

  switch (collection) {
    case 'operations': {
      const operation = record.operation;
      if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
        fail('snapshot_integrity_failed', 'recovered operation is missing');
      }

      if (
        record.sessionId !== sessionId ||
        (operation as Record<string, unknown>).tenantId !== tenantId
      ) {
        fail('snapshot_integrity_failed', 'operation belongs to a different tenant or session');
      }

      break;
    }

    case 'results': {
      for (const lineagePart of ['proposal', 'decision', 'grant', 'result'] as const) {
        assertProjectionScope(record[lineagePart], `recovered result ${lineagePart}`);
      }

      break;
    }

    default: {
      assertProjectionScope(record, `${collection} item`);
    }
  }
}

function snapshotCollectionGenesis(collection: RecoveryCollectionName): string {
  return sha256Bytes(Buffer.from(`${SNAPSHOT_COLLECTION_DOMAIN}\n${collection}\n`, 'ascii'));
}

function advanceSnapshotCollectionHash(
  collection: RecoveryCollectionName,
  previousHash: string,
  item: unknown,
): string {
  const itemId = snapshotItemId(collection, item);
  const itemDigest = digestCanonicalJson(item);
  return sha256Bytes(
    Buffer.from(
      `${SNAPSHOT_COLLECTION_DOMAIN}\n${collection}\n${previousHash}\n${itemId}\n${itemDigest}\n`,
      'ascii',
    ),
  );
}

export function snapshotCollectionBoundary(
  collection: RecoveryCollectionName,
  items: readonly unknown[],
): RecoveryCollectionBoundary {
  let collectionDigest = snapshotCollectionGenesis(collection);
  let previousId: string | undefined;
  for (const item of items) {
    const itemId = snapshotItemId(collection, item);
    if (previousId !== undefined && itemId <= previousId) {
      fail('snapshot_integrity_failed', `${collection} items are not strictly ordered`);
    }

    collectionDigest = advanceSnapshotCollectionHash(collection, collectionDigest, item);
    previousId = itemId;
  }

  return {collectionDigest, itemCount: items.length};
}

function assertSnapshotBoundaries(boundaries: RecoveryCollectionBoundaries): void {
  if (typeof boundaries !== 'object' || boundaries === null) {
    fail('snapshot_integrity_failed', 'snapshot collection boundaries are missing');
  }

  if (
    Object.keys(boundaries).sort().join(',') !==
    [...SNAPSHOT_COLLECTIONS].sort().join(',')
  ) {
    fail('snapshot_integrity_failed', 'snapshot collection boundaries are incomplete');
  }

  for (const collection of SNAPSHOT_COLLECTIONS) {
    const boundary = boundaries[collection];
    if (
      !boundary ||
      !Number.isSafeInteger(boundary.itemCount) ||
      boundary.itemCount < 0
    ) {
      fail('snapshot_integrity_failed', `${collection} itemCount is invalid`);
    }

    assertDigest(boundary.collectionDigest, `${collection} collectionDigest`);
  }
}

function assertSnapshotPageContext(context: SnapshotPageContext): void {
  if (
    !SNAPSHOT_COLLECTIONS.includes(context.collection) ||
    !Number.isSafeInteger(context.expectedPageStart) ||
    context.expectedPageStart < 0
  ) {
    fail('snapshot_cursor_mismatch', 'expected snapshot page scope is invalid');
  }
}

function assertSnapshotPageItemOrderAndScope(
  page: SnapshotPage,
  context: SnapshotPageContext,
): void {
  let previousId: string | undefined;
  for (const item of page.items) {
    assertSnapshotItemScope(page.collection, item, context.tenantId, context.sessionId);
    const itemId = snapshotItemId(page.collection, item);
    if (previousId !== undefined && itemId <= previousId) {
      fail('snapshot_integrity_failed', 'snapshot page items are not strictly ordered');
    }

    previousId = itemId;
  }
}

export function verifySnapshotPage(
  page: SnapshotPage,
  context: SnapshotPageContext,
  authority: SigningAuthority,
  now: number = Date.now(),
): void {
  assertEqual(page.protocolVersion, PROTOCOL_VERSION, 'snapshot protocolVersion');
  assertUuid(page.tenantId, 'snapshot tenantId');
  assertUuid(page.sessionId, 'snapshot sessionId');
  assertUuid(page.snapshotId, 'snapshot snapshotId');
  if (!Number.isSafeInteger(page.snapshotVersion) || page.snapshotVersion < 1) {
    fail('snapshot_integrity_failed', 'snapshotVersion is invalid');
  }

  if (!SNAPSHOT_COLLECTIONS.includes(page.collection)) {
    fail('snapshot_integrity_failed', 'snapshot collection is invalid');
  }

  assertSnapshotPageContext(context);

  const createdAt = parseTimestamp(page.snapshotCreatedAt, 'snapshotCreatedAt');
  const expiresAt = parseTimestamp(page.snapshotExpiresAt, 'snapshotExpiresAt');
  if (expiresAt - createdAt < 15 * 60 * 1000) {
    fail('snapshot_integrity_failed', 'snapshot retention is shorter than 15 minutes');
  }

  if (now >= expiresAt) {
    fail('snapshot_expired', 'snapshot has expired; discard partial recovery and restart');
  }

  assertSnapshotBoundaries(page.collectionBoundaries);
  if (
    page.collection !== context.collection ||
    page.pageStart !== context.expectedPageStart ||
    snapshotPageIdentity(page) !== snapshotPageIdentity(context)
  ) {
    fail('snapshot_cursor_mismatch', 'snapshot page does not match the requested frozen scope');
  }

  if (
    !Number.isSafeInteger(page.pageStart) ||
    page.pageStart < 0 ||
    page.items.length > 128
  ) {
    fail('snapshot_integrity_failed', 'snapshot page bounds are invalid');
  }

  const boundary = page.collectionBoundaries[page.collection];
  const nextOffset = page.pageStart + page.items.length;
  if (nextOffset > boundary.itemCount) {
    fail('snapshot_integrity_failed', 'snapshot page exceeds its frozen boundary');
  }

  assertSnapshotPageItemOrderAndScope(page, context);

  if (nextOffset < boundary.itemCount) {
    if (page.items.length === 0 || page.nextCursor === null) {
      fail('snapshot_integrity_failed', 'non-terminal snapshot page lacks a continuation');
    }

    verifySnapshotCursor(
      decodeSnapshotCursor(page.nextCursor),
      {
        collection: page.collection,
        collectionDigest: boundary.collectionDigest,
        expectedOffset: nextOffset,
        sessionId: page.sessionId,
        snapshotExpiresAt: page.snapshotExpiresAt,
        snapshotId: page.snapshotId,
        snapshotVersion: page.snapshotVersion,
        tenantId: page.tenantId,
      },
      authority,
      now,
    );
  } else if (page.nextCursor !== null) {
    fail('snapshot_integrity_failed', 'terminal snapshot page must not have a cursor');
  }
}

function snapshotPageIdentity(
  page: SnapshotCollectionContext | SnapshotPage,
): string {
  return canonicalizeJson({
    collection: page.collection,
    collectionBoundaries: page.collectionBoundaries,
    createdAt: page.createdAt,
    eventHead: page.eventHead,
    protocolVersion: page.protocolVersion,
    sessionId: page.sessionId,
    snapshotCreatedAt: page.snapshotCreatedAt,
    snapshotExpiresAt: page.snapshotExpiresAt,
    snapshotId: page.snapshotId,
    snapshotVersion: page.snapshotVersion,
    state: page.state,
    tenantId: page.tenantId,
    updatedAt: page.updatedAt,
  });
}

export function assembleSnapshotCollection(
  pages: readonly SnapshotPage[],
  context: SnapshotCollectionContext,
  authority: SigningAuthority,
  now: number = Date.now(),
): readonly unknown[] {
  if (pages.length === 0) {
    fail('snapshot_integrity_failed', 'at least one snapshot page is required');
  }

  const identity = snapshotPageIdentity(context);
  const {collection} = context;
  const boundary = context.collectionBoundaries[collection];
  const items: unknown[] = [];
  let expectedOffset = 0;
  let previousId: string | undefined;
  let collectionDigest = snapshotCollectionGenesis(collection);
  let terminalSeen = false;

  for (const page of pages) {
    if (terminalSeen) {
      fail('snapshot_integrity_failed', 'snapshot page appears after terminal completion');
    }

    if (page.pageStart !== expectedOffset) {
      fail('snapshot_integrity_failed', 'snapshot pages contain a gap or duplicate');
    }

    verifySnapshotPage(
      page,
      {...context, expectedPageStart: expectedOffset},
      authority,
      now,
    );
    if (snapshotPageIdentity(page) !== identity) {
      fail('snapshot_cursor_mismatch', 'snapshot page identity changed during pagination');
    }

    for (const item of page.items) {
      const itemId = snapshotItemId(collection, item);
      if (previousId !== undefined && itemId <= previousId) {
        fail('snapshot_integrity_failed', 'snapshot records contain duplicates or reordering');
      }

      collectionDigest = advanceSnapshotCollectionHash(
        collection,
        collectionDigest,
        item,
      );
      previousId = itemId;
      items.push(item);
    }

    expectedOffset += page.items.length;
    terminalSeen = page.nextCursor === null;
  }

  if (expectedOffset !== boundary.itemCount) {
    fail('snapshot_integrity_failed', 'snapshot collection is incomplete');
  }

  if (collectionDigest !== boundary.collectionDigest) {
    fail('snapshot_integrity_failed', 'snapshot collection digest does not match');
  }

  return items;
}

export function verifyRecoveredToolResult(
  recovered: RecoveredToolResultLineage,
  authorities: Pick<
    ToolLifecycleAuthorities,
    'decision' | 'grant' | 'proposal' | 'result'
  >,
): void {
  verifyToolResult(
    recovered.result,
    recovered.proposal,
    recovered.decision,
    recovered.grant,
    authorities,
  );
}

export const KNOWN_EVENT_TYPES = Object.freeze([
  'operation.committed',
  'session.created',
  'session.snapshot.required',
  'session.state.changed',
  'tool.decision.recorded',
  'tool.grant.issued',
  'tool.proposed',
  'tool.result.recorded',
  'usage.reported',
]);
function resolveServerSigningKey(
  keys: readonly ServerEventSigningKey[],
  keyId: string,
): ServerEventSigningKey {
  validateServerEventSigningKeys(keys);
  const matches = keys.filter((key) => key.keyId === keyId);
  if (matches.length !== 1) {
    fail('untrusted_event_key', 'event keyId must resolve to exactly one enrollment-pinned server key');
  }

  const [key] = matches;
  return key;
}

export function verifyEventEnvelope(
  envelope: SignedEventEnvelope,
  options: EventVerificationOptions,
): EventHead {
  if (!KNOWN_EVENT_TYPES.includes(envelope.eventType)) {
    fail('unknown_event_type', `unsupported event type: ${envelope.eventType}`);
  }

  assertEqual(envelope.tenantId, options.expectedTenantId, 'event tenantId');
  assertEqual(envelope.sessionId, options.expectedSessionId, 'event sessionId');
  const expectedHead = options.expectedHead;
  if (!Number.isSafeInteger(expectedHead.cursor) || expectedHead.cursor < 0) {
    fail('invalid_cursor', 'persisted event cursor must be a nonnegative safe integer');
  }

  if (expectedHead.cursor === 0) {
    if (expectedHead.eventHash !== null) fail('invalid_event_head', 'cursor zero requires a null event hash');
  } else if (expectedHead.eventHash) {
    assertDigest(expectedHead.eventHash, 'persisted event hash');
  } else {
    fail('invalid_event_head', 'a positive cursor requires an event hash');
  }

  if (envelope.sequence !== expectedHead.cursor + 1) {
    fail('event_sequence_gap', 'event sequence does not immediately follow the persisted cursor');
  }

  assertEqual(envelope.cursor, envelope.sequence, 'event cursor');
  assertEqual(envelope.previousEventHash, expectedHead.eventHash, 'event previousEventHash');
  const projection = createEventProjection({
    cursor: envelope.cursor,
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    occurredAt: envelope.occurredAt,
    payload: envelope.payload,
    previousEventHash: envelope.previousEventHash,
    sequence: envelope.sequence,
    sessionId: envelope.sessionId,
    tenantId: envelope.tenantId,
  });
  assertEqual(envelope.payloadDigest, projection.payloadDigest, 'event payloadDigest');
  assertEqual(envelope.eventHash, eventHash(projection), 'event hash');
  const serverKey = resolveServerSigningKey(
    options.serverSigningKeys,
    envelope.authorization.keyId,
  );
  const occurredAt = parseTimestamp(envelope.occurredAt, 'event occurredAt');
  if (
    occurredAt < parseTimestamp(serverKey.validFrom, 'server event key validFrom') ||
    occurredAt >= parseTimestamp(serverKey.validUntil, 'server event key validUntil')
  ) {
    fail('invalid_event_key', 'event occurred outside its pinned server key validity window');
  }

  assertAuthorization(
    EVENT_ENVELOPE_DOMAIN,
    projection,
    envelope.authorization,
    serverKey.publicKey,
    serverKey.keyId,
  );
  if (!options.validateEnvelope(envelope)) {
    fail('invalid_event_payload', 'event envelope does not match its closed discriminated schema');
  }

  canonicalSseEvent(envelope);
  return {cursor: envelope.cursor, eventHash: envelope.eventHash};
}

export function canonicalSseEvent(envelope: SignedEventEnvelope): Buffer {
  const bytes = Buffer.from(
    `id:${envelope.cursor}\nevent:${envelope.eventType}\ndata:${canonicalizeJson(envelope)}\n\n`,
    'utf8',
  );
  if (bytes.length > 262_144) fail('event_too_large', 'canonical SSE envelope exceeds 262144 bytes');
  return bytes;
}
