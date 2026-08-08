import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = path.join(root, 'protocol', 'schemas');
const check = process.argv.includes('--check');
const PRIVATE_KEY_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const REQUIRED_FEATURES = [
  'bound-ed25519-auth',
  'canonical-request-signing',
  'durable-idempotency',
  'operation-recovery',
  'snapshot-pagination-v1',
  'normalized-recovery-lineage-v1',
  'negotiated-limit-profile-v1',
  'pinned-server-event-keys',
  'signed-hash-chain-sse',
  'tool-authority-v1',
  'usage-reconciliation-v1',
];
const STRUCTURAL_LIMIT_KEYS = [
  'maxArrayItems',
  'maxCanonicalDepth',
  'maxCanonicalNodes',
  'maxObjectKeys',
  'maxRecoveryItemDepth',
  'maxRecoveryItemNodes',
  'maxRecoveryPageOverheadBytes',
  'maxRecoveryPageOverheadNodes',
  'maxStringBytes',
];
const OPERATIONAL_LIMIT_KEYS = [
  'maxBodyBytes',
  'maxEventBytes',
  'maxRecoveryItemBytes',
  'maxRecoveryPageItems',
  'maxToolArgumentsBytes',
  'maxToolDescriptors',
  'maxToolResultValueBytes',
];
const PROTOCOL_LIMIT_KEYS = [...STRUCTURAL_LIMIT_KEYS, ...OPERATIONAL_LIMIT_KEYS];
const RECOVERY_PAGE_DEPTH_OVERHEAD = 2;
const MIN_RECOVERY_ITEM_DEPTH = 3;
const TOOL_INPUT_SCHEMA_MAX_DEPTH = 5;
const CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD = 4;
const PROTOCOL_MANIFEST_FILE_COUNT = 23;
const PROTOCOL_MANDATORY_DTO_COUNT = 37;
const MIN_PROTOCOL_ARRAY_ITEMS = Math.max(
  REQUIRED_FEATURES.length,
  PROTOCOL_MANIFEST_FILE_COUNT,
  PROTOCOL_MANDATORY_DTO_COUNT,
);
const MIN_PROTOCOL_OBJECT_KEYS = PROTOCOL_LIMIT_KEYS.length;
const MIN_PROTOCOL_CANONICAL_DEPTH =
  Math.max(
    MIN_RECOVERY_ITEM_DEPTH + RECOVERY_PAGE_DEPTH_OVERHEAD,
    TOOL_INPUT_SCHEMA_MAX_DEPTH + CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD,
  );
const TOOL_PROPOSAL_ITEM_OVERHEAD_NODES = 64;
const MIN_TOOL_ARGUMENT_NODES = 257;
const MIN_RECOVERY_PAGE_OVERHEAD_NODES = 256;

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

const SNAPSHOT_COLLECTIONS = [
  'activeGrants',
  'decisions',
  'grants',
  'operations',
  'pendingProposals',
  'proposals',
  'results',
];
let maximumSnapshotCollection = '';
for (const collection of SNAPSHOT_COLLECTIONS) {
  if (collection.length > maximumSnapshotCollection.length) {
    maximumSnapshotCollection = collection;
  }
}

const maximumSnapshotCursorV1 = {
  authorization: {
    algorithm: 'Ed25519',
    keyId: 'ffffffff-ffff-8fff-bfff-ffffffffffff',
    signature: 'A'.repeat(86),
  },
  projection: {
    collection: maximumSnapshotCollection,
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
const MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES =
  Buffer.byteLength(stable(maximumSnapshotCursorV1), 'utf8');
const MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH =
  Math.ceil(MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES * 4 / 3);
const GENERATED_STRING_LIMITS = {
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
};
const MIN_PROTOCOL_STRING_BYTES = Math.max(...Object.values(GENERATED_STRING_LIMITS));
const STRUCTURAL_PROFILE = {
  maxArrayItems: MIN_PROTOCOL_ARRAY_ITEMS,
  maxCanonicalDepth: MIN_PROTOCOL_CANONICAL_DEPTH,
  maxCanonicalNodes:
    TOOL_PROPOSAL_ITEM_OVERHEAD_NODES
    + MIN_TOOL_ARGUMENT_NODES
    + MIN_RECOVERY_PAGE_OVERHEAD_NODES,
  maxObjectKeys: MIN_PROTOCOL_OBJECT_KEYS,
  maxRecoveryItemDepth: MIN_RECOVERY_ITEM_DEPTH,
  maxRecoveryItemNodes: TOOL_PROPOSAL_ITEM_OVERHEAD_NODES + MIN_TOOL_ARGUMENT_NODES,
  maxRecoveryPageOverheadBytes: 16_384,
  maxRecoveryPageOverheadNodes: MIN_RECOVERY_PAGE_OVERHEAD_NODES,
  maxStringBytes: MIN_PROTOCOL_STRING_BYTES,
};
const MINIMUM_OPERATIONAL_LIMITS = {
  maxBodyBytes: 21_504,
  maxEventBytes: 17_408,
  maxRecoveryItemBytes: 5120,
  maxRecoveryPageItems: 1,
  maxToolArgumentsBytes: 1024,
  maxToolDescriptors: 1,
  maxToolResultValueBytes: 1024,
};
const SERVER_OPERATIONAL_LIMITS = {
  maxBodyBytes: 1_048_576,
  maxEventBytes: 262_144,
  maxRecoveryItemBytes: 786_432,
  maxRecoveryPageItems: MIN_PROTOCOL_ARRAY_ITEMS,
  maxToolArgumentsBytes: 245_760,
  maxToolDescriptors: MIN_PROTOCOL_ARRAY_ITEMS,
  maxToolResultValueBytes: 524_288,
};
function pretty(value) {
  const normalized = JSON.parse(stable(value));
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizedUtf8Bytes(text) {
  return Buffer.from(text.replaceAll(/\r\n?/g, '\n'), 'utf8');
}

function digestJson(value) {
  return sha256(Buffer.from(stable(value), 'utf8'));
}

function projectionBytes(domain, projection) {
  return Buffer.from(`${domain}\n${stable(projection)}`, 'utf8');
}

function createSigner(seed) {
  const privateKey = createPrivateKey({
    format: 'der',
    key: Buffer.concat([PRIVATE_KEY_PREFIX, Buffer.from(seed, 'base64url')]),
    type: 'pkcs8',
  });
  const publicDer = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
  return {
    publicKey: Buffer.from(publicDer).subarray(PUBLIC_KEY_PREFIX.length).toString('base64url'),
    sign(domain, projection) {
      return sign(null, projectionBytes(domain, projection), privateKey).toString('base64url');
    },
  };
}

function digestProjection(domain, projection) {
  return sha256(projectionBytes(domain, projection));
}

function keyThumbprint(publicKey) {
  return createHash('sha256')
    .update(stable({crv: 'Ed25519', kty: 'OKP', x: publicKey}), 'utf8')
    .digest('base64url');
}

async function readSchemas() {
  const names = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  const schemas = new Map();
  for (const name of names) {
    schemas.set(name, JSON.parse(await readFile(path.join(schemaDirectory, name), 'utf8')));
  }

  return schemas;
}

function resolvePointer(document, pointer) {
  if (!pointer) return document;
  const parts = pointer
    .replace(/^#\//, '')
    .split('/');
  let value = document;
  for (const part of parts) {
    value = value[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }

  return value;
}

function createTypeRenderer(schemas, namedReferences) {
  function resolve(ref, currentFile) {
    const [file = currentFile, pointer = ''] = ref.split('#');
    const targetFile = file || currentFile;
    const document = schemas.get(targetFile);
    if (!document) throw new Error(`Unknown schema reference: ${ref}`);
    return {file: targetFile, schema: resolvePointer(document, pointer ? `#${pointer}` : '')};
  }

  // Schema composition necessarily has one branch per JSON Schema construct.
  // eslint-disable-next-line complexity
  function render(schema, currentFile, stack = new Set()) {
    if (!schema || typeof schema !== 'object') return 'unknown';
    if (schema.$ref) {
      if (schema.$ref.endsWith('common.schema.json#/$defs/JsonValue') || schema.$ref === '#/$defs/JsonValue') {
        return 'JsonValue';
      }

      const [file = currentFile, pointer = ''] = schema.$ref.split('#');
      const namedReference = namedReferences.get(`${file || currentFile}#${pointer}`);
      if (namedReference) return namedReference;

      const key = `${currentFile}:${schema.$ref}`;
      if (stack.has(key)) return 'JsonValue';
      const resolved = resolve(schema.$ref, currentFile);
      return render(resolved.schema, resolved.file, new Set([key, ...stack]));
    }

    if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
    if (schema.oneOf || schema.anyOf) {
      return (schema.oneOf ?? schema.anyOf).map((item) => render(item, currentFile, stack)).join(' | ');
    }

    if (schema.allOf) {
      const base = {...schema};
      delete base.allOf;
      delete base.unevaluatedProperties;
      const rendered = [
        render(base, currentFile, stack),
        ...schema.allOf
        .filter((item) => !item.if)
        .map((item) => render(item, currentFile, stack)),
      ].filter((item) => item !== 'unknown' && item !== 'Readonly<{}>');
      return rendered.length > 0 ? rendered.join(' & ') : 'unknown';
    }

    if (Array.isArray(schema.type)) {
      return schema.type.map((type) => render({...schema, type}, currentFile, stack)).join(' | ');
    }

    if (schema.type === 'null') return 'null';
    if (schema.type === 'boolean') return 'boolean';
    if (schema.type === 'number' || schema.type === 'integer') return 'number';
    if (schema.type === 'string') return 'string';
    if (schema.type === 'array') {
      const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
      const renderPrefixItem = (item) => {
        if (!item.$ref) return render(item, currentFile, stack);

        const refinement = {...item};
        delete refinement.$ref;
        const referenceType = render({$ref: item.$ref}, currentFile, stack);
        const refinementType = render(refinement, currentFile, stack);
        return refinementType === 'unknown'
          ? referenceType
          : `${referenceType} & ${refinementType}`;
      };

      const prefixItemTypes = prefixItems.map((item) => renderPrefixItem(item));
      if (prefixItemTypes.length > 0 && schema.items === false) {
        return `readonly [${prefixItemTypes.join(',')}]`;
      }

      const itemSchemas = [...prefixItems];
      if (itemSchemas.length === 0 && schema.items && typeof schema.items === 'object') {
        itemSchemas.push(schema.items);
      }

      const itemTypes = [...new Set(
        itemSchemas.map((item) => render(item, currentFile, stack)),
      )];
      return `ReadonlyArray<${itemTypes.length > 0 ? itemTypes.join(' | ') : 'never'}>`;
    }

    if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
      const required = new Set(schema.required ?? []);
      const members = Object.entries(schema.properties ?? {})
        .sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1)
        .map(([name, value]) => (
          `readonly ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${render(value, currentFile, stack)};`
        ));
      if (members.length === 0 && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `Readonly<Record<string, ${render(schema.additionalProperties, currentFile, stack)}>>`;
      }

      const object = `Readonly<{${members.join('')}}>`;
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `${object} & Readonly<Record<string, ${render(schema.additionalProperties, currentFile, stack)}>>`;
      }

      return object;
    }

    return 'unknown';
  }

  return render;
}

function generateDtos(schemas) {
  const protocol = schemas.get('protocol.schema.json');
  const exports = protocol['x-typescript-exports'];
  const namedReferences = new Map(
    Object.entries(exports).map(([name, ref]) => [ref, name]),
  );
  const render = createTypeRenderer(schemas, namedReferences);
  const declarations = Object.entries(exports)
    .sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1)
    .map(([name, ref]) => {
      const [file, pointer] = ref.split('#');
      const schema = resolvePointer(schemas.get(file), pointer ? `#${pointer}` : '');
      return `export type ${name} = ${render(schema, file)};`;
    });
  return [
    '/* This file is generated by scripts/generate-protocol.mjs. Do not edit. */',
    '/* eslint-disable perfectionist/sort-object-types, perfectionist/sort-union-types, unicorn/numeric-separators-style */',
    '',
    "import type {JsonValue} from '../canonical-json.js';",
    '',
    ...declarations,
    '',
  ].join('\n');
}

function generateVectors() {
  const privateSeed = Buffer.from(Array.from({length: 32}, (_, index) => index)).toString('base64url');
  const signer = createSigner(privateSeed);
  const newPrivateSeed = Buffer.from(Array.from({length: 32}, (_, index) => index + 32)).toString('base64url');
  const newSigner = createSigner(newPrivateSeed);
  const proposalPrivateSeed = Buffer.from(
    Array.from({length: 32}, (_, index) => index + 64),
  ).toString('base64url');
  const proposalSigner = createSigner(proposalPrivateSeed);
  const grantPrivateSeed = Buffer.from(
    Array.from({length: 32}, (_, index) => index + 96),
  ).toString('base64url');
  const grantSigner = createSigner(grantPrivateSeed);
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const deviceId = '22222222-2222-4222-8222-222222222222';
  const keyId = '33333333-3333-4333-8333-333333333333';
  const newKeyId = '12121212-1212-4121-8121-121212121212';
  const serverKeyId = '13131313-1313-4131-8131-131313131313';
  const proposalKeyId = '14141414-1414-4141-8141-141414141414';
  const grantKeyId = '15151515-1515-4151-8151-151515151515';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const requestId = '55555555-5555-4555-8555-555555555555';
  const idempotencyKey = '66666666-6666-4666-8666-666666666666';
  const accessToken = 'bound.access.token';
  const body = {
    deviceId,
    protocolVersion: '1.0',
    requestId,
    sessionId,
    tenantId,
  };
  const requestProjection = {
    accessTokenDigest: sha256(Buffer.from(accessToken, 'ascii')),
    bodyDigest: digestJson(body),
    bodyMediaType: 'application/json',
    canonicalPath: `/v1/sessions/${sessionId}/tool-decisions`,
    canonicalQuery: 'a=first&z=last',
    deviceId,
    idempotencyKey,
    keyId,
    method: 'POST',
    nonce: Buffer.from('0123456789abcdef', 'ascii').toString('base64url'),
    protocolVersion: '1.0',
    requestId,
    sessionId,
    tenantId,
    timestamp: '2026-01-02T03:04:05.000Z',
  };
  const keyRotationProjection = {
    currentKeyId: keyId,
    deviceId,
    newKeyId,
    newKeyThumbprint: keyThumbprint(newSigner.publicKey),
    newPublicKey: newSigner.publicKey,
    protocolVersion: '1.0',
    tenantId,
  };
  const descriptorProjection = {
    description: 'Read a bounded local file range',
    inputSchema: {
      additionalProperties: false,
      maxProperties: 1,
      properties: {
        pathDigest: {
          maxLength: 71,
          minLength: 71,
          type: 'string',
        },
      },
      required: ['pathDigest'],
      type: 'object',
    },
    name: 'local.read-file',
    protocolVersion: '1.0',
    schemaDigest: '',
    tenantId,
    version: '1.0.0',
  };
  descriptorProjection.schemaDigest = digestJson(descriptorProjection.inputSchema);
  const descriptorDigest = digestProjection('shadow-auditor/tool-descriptor/v1', descriptorProjection);
  const argumentsValue = {pathDigest: sha256(Buffer.from('src/example.ts', 'utf8'))};
  const proposalProjection = {
    argumentsDigest: digestJson(argumentsValue),
    budgetEstimate: {
      networkRequests: 0,
      outputBytes: 4096,
      wallClockMs: 1000,
    },
    descriptorDigest,
    expiresAt: '2026-01-02T03:09:05.000Z',
    proposalId: '77777777-7777-4777-8777-777777777777',
    protocolVersion: '1.0',
    risk: 'low',
    sessionId,
    tenantId,
    toolName: 'local.read-file',
  };
  const proposalDigest = digestProjection('shadow-auditor/tool-proposal/v1', proposalProjection);
  const decisionProjection = {
    decidedAt: '2026-01-02T03:04:06.000Z',
    decision: 'approved',
    decisionId: '88888888-8888-4888-8888-888888888888',
    proposalDigest,
    proposalId: proposalProjection.proposalId,
    protocolVersion: '1.0',
    reason: null,
    sessionId,
    tenantId,
  };
  const decisionDigest = digestProjection('shadow-auditor/tool-decision/v1', decisionProjection);
  const grantProjection = {
    allowedLimits: {
      networkRequests: 0,
      outputBytes: 4096,
      wallClockMs: 1000,
    },
    decision: 'approved',
    decisionDigest,
    expiresAt: '2026-01-02T03:09:06.000Z',
    grantId: '99999999-9999-4999-8999-999999999999',
    oneUseNonce: Buffer.from('grant-one-use-01', 'ascii').toString('base64url'),
    proposalDigest,
    proposalId: proposalProjection.proposalId,
    protocolVersion: '1.0',
    sessionId,
    tenantId,
  };
  const grantDigest = digestProjection('shadow-auditor/tool-grant/v1', grantProjection);
  const resultProjection = {
    completedAt: '2026-01-02T03:04:07.000Z',
    decisionDigest,
    errorDigest: null,
    evidenceDigest: digestJson('evidence-record'),
    executionLedgerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    grantDigest,
    grantId: grantProjection.grantId,
    outputDigest: digestJson({lines: 12}),
    proposalDigest,
    proposalId: proposalProjection.proposalId,
    protocolVersion: '1.0',
    resultId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sessionId,
    status: 'succeeded',
    tenantId,
  };
  const eventPayload = {
    snapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    snapshotVersion: 1,
  };
  const eventProjection = {
    cursor: 1,
    eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    eventType: 'session.created',
    occurredAt: '2026-01-02T03:04:08.000Z',
    payloadDigest: digestJson(eventPayload),
    previousEventHash: null,
    protocolVersion: '1.0',
    sequence: 1,
    sessionId,
    tenantId,
  };
  const snapshotCollectionDigest = sha256(
    Buffer.from('shadow-auditor/snapshot-collection/v1\noperations\n', 'ascii'),
  );
  const limitProfileDigest = digestJson({
    ...STRUCTURAL_PROFILE,
    ...SERVER_OPERATIONAL_LIMITS,
  });
  const snapshotCursorProjection = {
    collection: 'operations',
    collectionDigest: snapshotCollectionDigest,
    expiresAt: '2026-01-02T03:24:08.000Z',
    limitProfileDigest,
    nextOffset: SERVER_OPERATIONAL_LIMITS.maxRecoveryPageItems,
    protocolVersion: '1.0',
    sessionId,
    snapshotId: eventPayload.snapshotId,
    snapshotVersion: eventPayload.snapshotVersion,
    tenantId,
  };
  const snapshotCursor = {
    authorization: {
      algorithm: 'Ed25519',
      keyId: serverKeyId,
      signature: signer.sign(
        'shadow-auditor/snapshot-cursor/v1',
        snapshotCursorProjection,
      ),
    },
    projection: snapshotCursorProjection,
  };

  return {
    algorithm: 'Ed25519',
    eventChain: {
      eventHash: digestProjection('shadow-auditor/event-envelope/v1', eventProjection),
      negative: [
        'sequence-gap',
        'cursor-sequence-mismatch',
        'wrong-previous-hash',
        'payload-digest-mismatch',
        'event-hash-mismatch',
        'event-type-payload-mismatch',
        'unknown-event-type',
      ],
      payload: eventPayload,
      projection: eventProjection,
      serverSigningKey: {
        algorithm: 'Ed25519',
        keyId: serverKeyId,
        keyThumbprint: keyThumbprint(signer.publicKey),
        publicKey: signer.publicKey,
        retainUntil: '2027-02-01T00:00:00.000Z',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2027-01-01T00:00:00.000Z',
      },
      signature: signer.sign('shadow-auditor/event-envelope/v1', eventProjection),
    },
    invalidCanonicalJson: [
      {
        expectedCode: 'duplicate_key',
        name: 'duplicate-key',
        source: '{"a":1,"a":2}',
      },
      {
        expectedCode: 'unsafe_integer',
        name: 'unsafe-integer',
        source: '9007199254740992',
      },
      {
        expectedCode: 'invalid_number',
        name: 'negative-zero',
        source: '-0',
      },
      {
        expectedCode: 'invalid_unicode',
        name: 'unpaired-surrogate',
        source: String.raw`"\ud800"`,
      },
    ],
    jcs: [
      {
        canonical: '{"a":1,"nested":{"a":true,"z":null},"z":"last"}',
        digest: digestJson({
          a: 1,
          nested: {
            a: true,
            z: null,
          },
          z: 'last',
        }),
        name: 'object-order-and-number',
        value: {
          a: 1,
          nested: {
            a: true,
            z: null,
          },
          z: 'last',
        },
      },
      {
        canonical: '"snowman \u2603"',
        digest: digestJson('snowman \u2603'),
        name: 'json-string-is-quoted',
        value: 'snowman \u2603',
      },
    ],
    keyRotation: {
      domain: 'shadow-auditor/key-rotation/v1',
      negative: [
        'proof-key-id-mismatch',
        'new-key-thumbprint-mismatch',
        'new-public-key-mismatch',
        'projection-tampering',
        'malformed-new-key-proof',
      ],
      newPrivateSeed,
      newPublicKey: newSigner.publicKey,
      projection: keyRotationProjection,
      proof: {
        algorithm: 'Ed25519',
        keyId: newKeyId,
        signature: newSigner.sign('shadow-auditor/key-rotation/v1', keyRotationProjection),
      },
      signingInput: `shadow-auditor/key-rotation/v1\n${stable(keyRotationProjection)}`,
    },
    privateSeed,
    protocolVersion: '1.0',
    publicKey: signer.publicKey,
    request: {
      accessToken,
      body,
      canonicalProjection: stable(requestProjection),
      domain: 'shadow-auditor/request-signature/v1',
      negative: [
        {
          expectedCode: 'binding_mismatch',
          mutation: 'body.requestId',
          name: 'tampered-body',
        },
        {
          expectedCode: 'ambiguous_path',
          mutation: 'path.percent-encoded-separator',
          name: 'altered-path',
        },
        {
          expectedCode: 'noncanonical_url',
          mutation: 'query.unsorted',
          name: 'altered-query-order',
        },
        {
          expectedCode: 'stale_request',
          mutation: 'timestamp.minus-301-seconds',
          name: 'stale-time',
        },
        {
          expectedCode: 'nonce_reuse',
          mutation: 'nonce.reuse',
          name: 'nonce-replay',
        },
        {
          expectedCode: 'binding_mismatch',
          mutation: 'idempotencyKey',
          name: 'altered-idempotency-key',
        },
      ],
      projection: requestProjection,
      signature: signer.sign('shadow-auditor/request-signature/v1', requestProjection),
      signingInput: `shadow-auditor/request-signature/v1\n${stable(requestProjection)}`,
    },
    snapshotCursor: {
      canonicalCursor: stable(snapshotCursor),
      collectionGenesisDigest: snapshotCollectionDigest,
      domain: 'shadow-auditor/snapshot-cursor/v1',
      negative: [
        'cross-snapshot-reuse',
        'cross-collection-reuse',
        'altered-offset',
        'altered-boundary-digest',
        'expired-snapshot',
        'noncanonical-token',
      ],
      projection: snapshotCursorProjection,
      signature: snapshotCursor.authorization.signature,
      token: Buffer.from(stable(snapshotCursor), 'utf8').toString('base64url'),
    },
    toolLifecycle: {
      decision: {
        digest: decisionDigest,
        projection: decisionProjection,
        signature: signer.sign('shadow-auditor/tool-decision/v1', decisionProjection),
      },
      descriptor: {
        digest: descriptorDigest,
        projection: descriptorProjection,
        signature: signer.sign('shadow-auditor/tool-descriptor/v1', descriptorProjection),
      },
      grant: {
        digest: grantDigest,
        projection: grantProjection,
        signature: grantSigner.sign('shadow-auditor/tool-grant/v1', grantProjection),
      },
      grantPrivateSeed,
      negative: [
        'arguments-digest-mismatch',
        'denied-decision-grant',
        'expired-grant',
        'reused-grant-nonce',
        'proposal-digest-mismatch',
        'decision-digest-mismatch',
        'output-digest-mismatch',
        'ambiguous-result-without-error-digest',
        'cross-role-signature',
        'duplicate-server-key-id-or-material',
      ],
      proposal: {
        arguments: argumentsValue,
        digest: proposalDigest,
        projection: proposalProjection,
        signature: proposalSigner.sign('shadow-auditor/tool-proposal/v1', proposalProjection),
      },
      proposalPrivateSeed,
      result: {
        digest: digestProjection('shadow-auditor/tool-result/v1', resultProjection),
        projection: resultProjection,
        signature: signer.sign('shadow-auditor/tool-result/v1', resultProjection),
      },
      serverSigningKeys: [
        {
          algorithm: 'Ed25519',
          keyId: proposalKeyId,
          keyThumbprint: keyThumbprint(proposalSigner.publicKey),
          publicKey: proposalSigner.publicKey,
          role: 'proposal',
        },
        {
          algorithm: 'Ed25519',
          keyId: grantKeyId,
          keyThumbprint: keyThumbprint(grantSigner.publicKey),
          publicKey: grantSigner.publicKey,
          role: 'grant',
        },
      ],
    },
  };
}

async function collectManifestFiles(schemaNames) {
  return [
    'protocol/invariant-matrix.json',
    'protocol/openapi.json',
    ...schemaNames.map((name) => `protocol/schemas/${name}`),
    'protocol/signing-vectors.json',
    'scripts/generate-protocol.mjs',
    'src/protocol/canonical-json.ts',
    'src/protocol/generated/dtos.ts',
    'src/protocol/generated/profile.ts',
    'src/protocol/index.ts',
    'src/protocol/negotiated-limits.ts',
    'src/protocol/signing.ts',
  ].sort();
}

function tsValue(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll(/^(\s*)"([^"]+)":/gm, '$1$2:');
}

function generateProfileSource() {
  return `/* eslint-disable unicorn/numeric-separators-style */
// Generated by scripts/generate-protocol.mjs. Do not edit.

export const STRUCTURAL_LIMIT_KEYS = Object.freeze(${tsValue(STRUCTURAL_LIMIT_KEYS)} as const);

export const OPERATIONAL_LIMIT_KEYS = Object.freeze(${tsValue(OPERATIONAL_LIMIT_KEYS)} as const);

export const PROTOCOL_LIMIT_KEYS = Object.freeze([
  ...STRUCTURAL_LIMIT_KEYS,
  ...OPERATIONAL_LIMIT_KEYS,
] as const);

export const REQUIRED_PROTOCOL_FEATURES = Object.freeze(${tsValue(REQUIRED_FEATURES)} as const);

export const RECOVERY_PAGE_DEPTH_OVERHEAD = ${RECOVERY_PAGE_DEPTH_OVERHEAD};
export const MIN_RECOVERY_PAGE_OVERHEAD_BYTES = 16_384;
export const MIN_RECOVERY_PAGE_OVERHEAD_NODES = ${MIN_RECOVERY_PAGE_OVERHEAD_NODES};
export const TOOL_PROPOSAL_ITEM_OVERHEAD_BYTES = 4096;
export const TOOL_PROPOSAL_ITEM_OVERHEAD_NODES = ${TOOL_PROPOSAL_ITEM_OVERHEAD_NODES};
export const TOOL_PROPOSAL_EVENT_OVERHEAD_BYTES = 16_384;
export const TOOL_PROPOSAL_EVENT_OVERHEAD_NODES = 256;
export const MIN_TOOL_ARGUMENT_NODES = ${MIN_TOOL_ARGUMENT_NODES};
export const PROTOCOL_MANIFEST_FILE_COUNT = ${PROTOCOL_MANIFEST_FILE_COUNT};
export const PROTOCOL_MANDATORY_DTO_COUNT = ${PROTOCOL_MANDATORY_DTO_COUNT};
export const MIN_PROTOCOL_ARRAY_ITEMS = ${MIN_PROTOCOL_ARRAY_ITEMS};
export const MIN_PROTOCOL_OBJECT_KEYS = ${MIN_PROTOCOL_OBJECT_KEYS};
export const MIN_RECOVERY_ITEM_DEPTH = ${MIN_RECOVERY_ITEM_DEPTH};
export const MIN_PROTOCOL_CANONICAL_DEPTH = ${MIN_PROTOCOL_CANONICAL_DEPTH};
export const TOOL_INPUT_SCHEMA_MAX_DEPTH = ${TOOL_INPUT_SCHEMA_MAX_DEPTH};
export const CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD = ${CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD};

export const SNAPSHOT_CURSOR_AUTHORIZATION_FIELDS = Object.freeze(${tsValue([
    'algorithm',
    'keyId',
    'signature',
  ])} as const);

export const SNAPSHOT_CURSOR_PROJECTION_FIELDS = Object.freeze(${tsValue([
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
  ])} as const);

export const SNAPSHOT_CURSOR_COLLECTION_NAMES = Object.freeze(${tsValue(SNAPSHOT_COLLECTIONS)} as const);

export const MIN_SNAPSHOT_CURSOR_TOKEN_LENGTH = 128;
export const MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES = ${MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES};
export const MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH = ${MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH};

export const PROTOCOL_GENERATED_STRING_MAX_BYTES = Object.freeze(${tsValue(GENERATED_STRING_LIMITS)} as const);

export const MIN_PROTOCOL_STRING_BYTES = ${MIN_PROTOCOL_STRING_BYTES};

export const PROTOCOL_STRUCTURAL_PROFILE = Object.freeze(${tsValue(STRUCTURAL_PROFILE)} as const);

export const MINIMUM_OPERATIONAL_LIMITS = Object.freeze(${tsValue(MINIMUM_OPERATIONAL_LIMITS)} as const);

export const SERVER_OPERATIONAL_LIMITS = Object.freeze(${tsValue(SERVER_OPERATIONAL_LIMITS)} as const);
`;
}

async function writeOrCheck(relativePath, expected) {
  const absolutePath = path.join(root, relativePath);
  let actual;
  try {
    actual = (await readFile(absolutePath, 'utf8')).replaceAll(/\r\n?/g, '\n');
  } catch {
    actual = undefined;
  }

  if (check) {
    if (actual !== expected) throw new Error(`Protocol artifact drift: ${relativePath}`);
  } else if (actual !== expected) {
    await mkdir(path.dirname(absolutePath), {recursive: true});
    await writeFile(absolutePath, expected, 'utf8');
  }
}

function largestClosedObject(value, location = '#', current) {
  if (value === null || typeof value !== 'object') {
    return current ?? {keys: 0, location: '#'};
  }

  let largest = current ?? {keys: 0, location: '#'};
  if (
    !Array.isArray(value) &&
    value.additionalProperties === false &&
    value.properties &&
    typeof value.properties === 'object'
  ) {
    const keys = Object.keys(value.properties).length;
    if (keys > largest.keys) largest = {keys, location};
  }

  for (const [key, child] of Object.entries(value)) {
    largest = largestClosedObject(child, `${location}/${key}`, largest);
  }

  return largest;
}

const RECOVERY_COLLECTION_BY_DTO = Object.freeze({
  Operation: 'operations',
  RecoveredOperation: 'operations',
  ToolDecision: 'decisions',
  ToolGrant: 'grants',
  ToolProposal: 'proposals',
  ToolResult: 'results',
});

function dtoFlow(name) {
  if (name.includes('Snapshot') || name === 'RecoveredOperation') {
    return 'snapshot-consistent-recovery';
  }

  if (name.includes('Enrollment') || name.includes('Refresh') || name.includes('Token')) {
    return 'enrollment-and-bound-authentication';
  }

  if (name.startsWith('Tool')) return 'local-tool-authority';
  if (name.includes('Usage')) return 'provider-usage-reconciliation';
  if (name.includes('Key') || name.includes('Revoke') || name.includes('Rotate')) {
    return 'key-rotation-and-revocation';
  }

  if (name.includes('Session')) return 'session-lifecycle';
  if (name.includes('Capabilities')) return 'capability-negotiation';
  if (name.includes('RequestSigning')) return 'bound-request-signing';
  if (name === 'EventEnvelope') return 'durable-signed-events';
  if (name === 'Operation') return 'durable-idempotency-and-recovery';
  if (name === 'Problem') return 'rfc-9457-problems';
  if (name === 'ProtocolManifest' || name === 'InvariantMatrix') return 'protocol-pinning';
  return 'protocol-contract';
}

function generateInvariantMatrix(protocolExports) {
  const exportEntries = Object.entries(protocolExports).sort(([left], [right]) => (
    left < right ? -1 : left === right ? 0 : 1
  ));
  if (exportEntries.length !== PROTOCOL_MANDATORY_DTO_COUNT) {
    throw new Error(
      `Expected ${PROTOCOL_MANDATORY_DTO_COUNT} mandatory DTO exports, found ${exportEntries.length}`,
    );
  }

  const mandatoryDtos = exportEntries.map(([name, schema]) => {
    const collection = RECOVERY_COLLECTION_BY_DTO[name] ?? null;
    const recoveryRecord = collection !== null;
    const recoveryEnvelope = name === 'SessionSnapshotPage';
    const event = name === 'EventEnvelope';
    const packageArtifact = name === 'InvariantMatrix';
    const arrayGoverningLimit = name === 'CreateSessionRequest'
      ? 'maxArrayItems and maxToolDescriptors'
      : recoveryEnvelope
        ? 'maxArrayItems and maxRecoveryPageItems'
        : 'maxArrayItems';
    const byteGoverningLimit = name === 'ToolProposal'
      ? 'maxRecoveryItemBytes; arguments additionally maxToolArgumentsBytes'
      : name === 'ToolResult'
        ? 'maxRecoveryItemBytes; supplied values additionally maxToolResultValueBytes and output additionally grant.allowedLimits.outputBytes'
        : event
          ? 'maxEventBytes'
          : recoveryRecord
            ? 'maxRecoveryItemBytes'
            : 'maxBodyBytes';
    return {
      acceptanceToRecovery: {
        collection,
        guarantee: recoveryRecord
          ? 'accepted-record-is-recoverable'
          : recoveryEnvelope
            ? 'recovery-page-envelope'
            : 'not-a-recovery-record',
        lineageCollections: name === 'ToolResult'
          ? ['decisions', 'grants', 'proposals']
          : [],
      },
      arrayCardinality: packageArtifact ? null : {
        fixedMaximum: STRUCTURAL_PROFILE.maxArrayItems,
        governingLimit: arrayGoverningLimit,
        unit: 'items',
      },
      canonicalBytes: packageArtifact ? null : {
        governingLimit: byteGoverningLimit,
        hardMaximum: event
          ? SERVER_OPERATIONAL_LIMITS.maxEventBytes
          : recoveryRecord
            ? SERVER_OPERATIONAL_LIMITS.maxRecoveryItemBytes
            : SERVER_OPERATIONAL_LIMITS.maxBodyBytes,
        minimumOperational: event
          ? MINIMUM_OPERATIONAL_LIMITS.maxEventBytes
          : recoveryRecord
            ? MINIMUM_OPERATIONAL_LIMITS.maxRecoveryItemBytes
            : MINIMUM_OPERATIONAL_LIMITS.maxBodyBytes,
        unit: 'utf8-bytes',
      },
      depth: packageArtifact ? null : {
        fixedMaximum: recoveryRecord
          ? STRUCTURAL_PROFILE.maxRecoveryItemDepth
          : STRUCTURAL_PROFILE.maxCanonicalDepth,
        governingLimit: name === 'CreateSessionRequest'
          ? 'maxCanonicalDepth; tool input schema depth 5 plus CreateSessionRequest embedding depth 4'
          : name === 'ToolDescriptor'
            ? 'maxCanonicalDepth; tool input schema depth is independently capped at 5'
            : recoveryRecord
              ? 'maxRecoveryItemDepth and maxCanonicalDepth'
              : 'maxCanonicalDepth',
        unit: 'levels',
      },
      flow: dtoFlow(name),
      generatedStrings: packageArtifact ? null : {
        fixedMaximum: STRUCTURAL_PROFILE.maxStringBytes,
        governingLimit: 'maxStringBytes',
        unit: 'utf8-bytes',
      },
      name,
      nodes: packageArtifact ? null : {
        fixedMaximum: recoveryRecord
          ? STRUCTURAL_PROFILE.maxRecoveryItemNodes
          : STRUCTURAL_PROFILE.maxCanonicalNodes,
        governingLimit: recoveryRecord
          ? 'maxRecoveryItemNodes and maxCanonicalNodes'
          : 'maxCanonicalNodes',
        unit: 'nodes',
      },
      objectKeys: packageArtifact ? null : {
        fixedMaximum: STRUCTURAL_PROFILE.maxObjectKeys,
        governingLimit: 'maxObjectKeys',
        unit: 'keys',
      },
      safeIntegers: packageArtifact ? null : {
        fixedMaximum: Number.MAX_SAFE_INTEGER,
        fixedMinimum: Number.MIN_SAFE_INTEGER,
        governingLimit: 'I-JSON safe integer range plus referenced schema-specific constraints',
        unit: 'safe-integer',
      },
      schema,
      scope: packageArtifact ? 'package-artifact' : 'wire',
    };
  });

  return {
    derivations: {
      arrayCardinality: 'max(requiredFeatures.length, manifest.files.length, mandatoryDtos.length)',
      createSessionDescriptorDepth: 'tool input schema depth 5 plus CreateSessionRequest embedding depth 4',
      objectKeys: 'max(effective Protocol 1.0 limit-profile keys, mandatory snapshot-page keys)',
      recoveryDepth: 'max recovery item depth 3 plus page wrapper depth 2',
    },
    flowGuarantees: SNAPSHOT_COLLECTIONS.map((collection) => ({
      collection,
      itemLimit: 'maxRecoveryItemBytes/maxRecoveryItemNodes/maxRecoveryItemDepth',
      ordering: 'strict ascending stable UUID within one immutable snapshot',
      pageLimit: 'maxBodyBytes/maxCanonicalNodes/maxCanonicalDepth/maxRecoveryPageItems',
      progress: 'longest fitting prefix; at least one accepted record per non-terminal page',
    })),
    generatedStringLimits: GENERATED_STRING_LIMITS,
    mandatoryDtos,
    operationalQuotas: {
      hardMaximum: SERVER_OPERATIONAL_LIMITS,
      minimumCompatible: MINIMUM_OPERATIONAL_LIMITS,
    },
    protocolVersion: '1.0',
    safeInteger: {
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: Number.MIN_SAFE_INTEGER,
    },
    structuralProfile: STRUCTURAL_PROFILE,
  };
}

async function main() {
  const schemas = await readSchemas();
  const featureEnum = schemas.get('capabilities.schema.json')?.$defs?.Feature?.enum;
  if (!Array.isArray(featureEnum)) {
    throw new TypeError('Capability feature enum is missing');
  }

  if (stable(featureEnum) !== stable(REQUIRED_FEATURES)) {
    throw new Error('Capability feature enum drifted from the frozen required feature list');
  }

  const commonSchema = schemas.get('common.schema.json');
  const capabilitiesSchema = schemas.get('capabilities.schema.json');
  const manifestSchema = schemas.get('manifest.schema.json');
  const protocolSchema = schemas.get('protocol.schema.json');
  const sessionsSchema = schemas.get('sessions.schema.json');
  const toolsSchema = schemas.get('tools.schema.json');
  const structuralProfile = commonSchema?.$defs?.ProtocolStructuralProfile;
  const operationalLimits = commonSchema?.$defs?.OperationalLimits;
  const effectiveLimits = commonSchema?.$defs?.EffectiveProtocolLimits;
  const negotiatedFeatureMinimum =
    capabilitiesSchema?.$defs?.NegotiatedCapabilities?.properties?.features?.minItems;
  const schemaStructuralKeys = Object.keys(structuralProfile?.properties ?? {}).sort();
  const requiredStructuralKeys = [...(structuralProfile?.required ?? [])].sort();
  const schemaOperationalKeys = Object.keys(operationalLimits?.properties ?? {}).sort();
  const requiredOperationalKeys = [...(operationalLimits?.required ?? [])].sort();
  const effectiveLimitKeys = Object.keys(effectiveLimits?.properties ?? {}).sort();
  const requiredEffectiveLimitKeys = [...(effectiveLimits?.required ?? [])].sort();
  const snapshotPageBaseKeys = Object.keys(
    sessionsSchema?.$defs?.SnapshotPageBase?.properties ?? {},
  ).length;
  const concreteSnapshotPageKeyCounts = Object.entries(sessionsSchema?.$defs ?? {})
    .filter(([name, schema]) =>
      name.endsWith('SnapshotPage')
      && name !== 'SessionSnapshotPage'
      && schema?.properties
    )
    .map(([, schema]) => snapshotPageBaseKeys + Object.keys(schema.properties).length);
  const mandatorySnapshotPageKeys = Math.max(...concreteSnapshotPageKeyCounts);
  const frozenStructuralKeys = [...STRUCTURAL_LIMIT_KEYS].sort();
  const frozenOperationalKeys = [...OPERATIONAL_LIMIT_KEYS].sort();
  const frozenLimitKeys = [...PROTOCOL_LIMIT_KEYS].sort();
  const structuralSchemaMatches = Object.entries(STRUCTURAL_PROFILE).every(
    ([key, value]) =>
      structuralProfile?.properties?.[key]?.const === value &&
      effectiveLimits?.properties?.[key]?.const === value,
  );
  const operationalSchemaMatches = Object.entries(MINIMUM_OPERATIONAL_LIMITS).every(
    ([key, minimum]) =>
      operationalLimits?.properties?.[key]?.minimum === minimum &&
      operationalLimits?.properties?.[key]?.maximum === Number.MAX_SAFE_INTEGER &&
      effectiveLimits?.properties?.[key]?.minimum === minimum &&
      effectiveLimits?.properties?.[key]?.maximum === SERVER_OPERATIONAL_LIMITS[key],
  );
  let largestProtocolObject = {keys: 0, location: '#'};
  for (const [name, schema] of schemas) {
    largestProtocolObject = largestClosedObject(
      schema,
      `protocol/schemas/${name}#`,
      largestProtocolObject,
    );
  }

  if (
    stable(schemaStructuralKeys) !== stable(frozenStructuralKeys) ||
    stable(requiredStructuralKeys) !== stable(frozenStructuralKeys) ||
    stable(schemaOperationalKeys) !== stable(frozenOperationalKeys) ||
    stable(requiredOperationalKeys) !== stable(frozenOperationalKeys) ||
    stable(effectiveLimitKeys) !== stable(frozenLimitKeys) ||
    stable(requiredEffectiveLimitKeys) !== stable(frozenLimitKeys) ||
    !structuralSchemaMatches ||
    !operationalSchemaMatches ||
    MIN_PROTOCOL_OBJECT_KEYS !== Math.max(
      PROTOCOL_LIMIT_KEYS.length,
      mandatorySnapshotPageKeys,
    ) ||
    negotiatedFeatureMinimum !== REQUIRED_FEATURES.length ||
    sessionsSchema?.$defs?.SnapshotCursor?.['x-max-canonical-bytes'] !==
      MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES ||
    sessionsSchema?.$defs?.SnapshotCursorToken?.maxLength !==
      MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH ||
    toolsSchema?.$defs?.AllowedLimits?.properties?.outputBytes?.maximum !==
      SERVER_OPERATIONAL_LIMITS.maxToolResultValueBytes ||
    toolsSchema?.$defs?.BudgetEstimate?.properties?.outputBytes?.maximum !==
      SERVER_OPERATIONAL_LIMITS.maxToolResultValueBytes ||
    sessionsSchema?.$defs?.CreateSessionRequest?.['x-shadow-semantic-validator'] !==
      'validateCreateSessionRequest' ||
    toolsSchema?.$defs?.ToolInputSchema?.['x-shadow-max-canonical-depth'] !==
      TOOL_INPUT_SCHEMA_MAX_DEPTH
  ) {
    throw new Error('Generated structural, string, or snapshot cursor schema bounds drifted');
  }

  if (largestProtocolObject.keys > MIN_PROTOCOL_OBJECT_KEYS) {
    throw new Error(
      `Closed protocol object ${largestProtocolObject.location} has ${largestProtocolObject.keys} keys, exceeding the minimum compatible profile`,
    );
  }

  const schemaNames = [...schemas.keys()];
  const protocolExports = protocolSchema?.['x-typescript-exports'];
  if (!protocolExports || Object.keys(protocolExports).length !== PROTOCOL_MANDATORY_DTO_COUNT) {
    throw new Error('Protocol DTO export cardinality drifted from the frozen structural profile');
  }

  const manifestFilePaths = await collectManifestFiles(schemaNames);
  const manifestSchemaPaths = (
    manifestSchema?.properties?.files?.prefixItems ?? []
  ).map((item) => item?.properties?.path?.const);
  if (
    manifestFilePaths.length !== PROTOCOL_MANIFEST_FILE_COUNT ||
    stable(manifestSchemaPaths) !== stable(manifestFilePaths) ||
    MIN_PROTOCOL_ARRAY_ITEMS !== Math.max(
      REQUIRED_FEATURES.length,
      manifestFilePaths.length,
      Object.keys(protocolExports).length,
    )
  ) {
    throw new Error('Frozen array capacity drifted from required features, files, or DTOs');
  }

  const normalizedJson = new Map();
  for (const name of schemaNames) {
    normalizedJson.set(`protocol/schemas/${name}`, pretty(schemas.get(name)));
  }

  const openapi = JSON.parse(await readFile(path.join(root, 'protocol', 'openapi.json'), 'utf8'));
  normalizedJson.set('protocol/invariant-matrix.json', pretty(generateInvariantMatrix(protocolExports)));
  normalizedJson.set('protocol/openapi.json', pretty(openapi));
  normalizedJson.set('protocol/signing-vectors.json', pretty(generateVectors()));

  for (const [relativePath, contents] of normalizedJson) {
    await writeOrCheck(relativePath, contents);
  }

  await writeOrCheck('src/protocol/generated/dtos.ts', generateDtos(schemas));
  await writeOrCheck('src/protocol/generated/profile.ts', generateProfileSource());

  const files = [];
  for (const relativePath of manifestFilePaths) {
    const contents = normalizedUtf8Bytes(await readFile(path.join(root, relativePath), 'utf8'));
    files.push({
      bytes: contents.byteLength,
      path: relativePath.replaceAll('\\', '/'),
      sha256: sha256(contents),
    });
  }

  const manifestProjection = {
    canonicalJson: {
      generatedStrings: {
        fixedMaxStringBytes: MIN_PROTOCOL_STRING_BYTES,
        limits: GENERATED_STRING_LIMITS,
        snapshotCursor: {
          canonicalMaxBytes: MAX_SNAPSHOT_CURSOR_CANONICAL_BYTES,
          encoding: 'unpadded-base64url',
          schema: 'protocol/schemas/sessions.schema.json#/$defs/SnapshotCursor',
          tokenMaxCharacters: MAX_SNAPSHOT_CURSOR_TOKEN_LENGTH,
        },
        unitSemantics: 'All values are maximum UTF-8 bytes; snapshotCursor.tokenMaxCharacters is also bytes because base64url is ASCII. Problem title, detail, and instance conservatively allow four UTF-8 bytes per schema code point.',
      },
      limitInvariants: {
        cardinalities: {
          invariantMatrix: 'protocol/invariant-matrix.json',
          largestMandatoryArray: 'protocol/invariant-matrix.json#/mandatoryDtos',
          largestMandatoryClosedObject: 'protocol/schemas/common.schema.json#/$defs/EffectiveProtocolLimits',
          mandatoryDtoCount: Object.keys(protocolExports).length,
          manifestFileCount: manifestFilePaths.length,
          minimumArrayItems: MIN_PROTOCOL_ARRAY_ITEMS,
          minimumObjectKeys: MIN_PROTOCOL_OBJECT_KEYS,
          requiredFeatureCount: REQUIRED_FEATURES.length,
        },
        recovery: {
          minimumCanonicalDepth: MIN_PROTOCOL_CANONICAL_DEPTH,
          minimumRecoveryItemDepth: MIN_RECOVERY_ITEM_DEPTH,
          minimumRecoveryPageOverheadBytes: 16_384,
          minimumRecoveryPageOverheadNodes: 256,
          recoveryPageDepthOverhead: RECOVERY_PAGE_DEPTH_OVERHEAD,
        },
        compositions: {
          createSessionDescriptorDepthOverhead: CREATE_SESSION_DESCRIPTOR_DEPTH_OVERHEAD,
          maximumToolInputSchemaDepth: TOOL_INPUT_SCHEMA_MAX_DEPTH,
          minimumCanonicalDepth: MIN_PROTOCOL_CANONICAL_DEPTH,
          relationship: 'maxCanonicalDepth >= maximumToolInputSchemaDepth + createSessionDescriptorDepthOverhead',
        },
        semantics: {
          minimumStringBytes: MIN_PROTOCOL_STRING_BYTES,
          profileDigestSemantics: 'SHA-256 over strict canonical JSON of the complete effective limits object.',
          semanticValidator: 'negotiateProtocolLimits',
        },
        toolProposal: {
          eventOverheadBytes: 16_384,
          eventOverheadNodes: 256,
          itemOverheadBytes: 4096,
          itemOverheadNodes: 64,
        },
      },
      operationalQuotas: {
        minimumCompatible: MINIMUM_OPERATIONAL_LIMITS,
        serverHardMaximum: SERVER_OPERATIONAL_LIMITS,
      },
      profile: 'RFC 8785 JCS over strict I-JSON',
      structuralProfile: STRUCTURAL_PROFILE,
      unitSemantics: 'maxStringBytes and maxBodyBytes count UTF-8 bytes; maxCanonicalDepth and maxCanonicalNodes are aggregate runtime limits not expressible by JSON Schema.',
      validationSteps: [
        'strict-json-parse',
        'json-schema-2020-12',
        'bounded-canonical-json',
      ],
    },
    digestAlgorithm: 'sha256',
    fileDigestSemantics: 'SHA-256 over UTF-8 text after CRLF and CR normalization to LF; manifest.json is excluded to avoid self-reference.',
    files,
    protocolDigestSemantics: 'SHA-256 over strict canonical JSON of every manifest member except protocolDigest.',
    protocolVersion: '1.0',
    release: '1.0.0',
    requiredFeatures: REQUIRED_FEATURES,
    signingDomains: [
      'shadow-auditor/request-signature/v1',
      'shadow-auditor/snapshot-cursor/v1',
      'shadow-auditor/key-rotation/v1',
      'shadow-auditor/tool-descriptor/v1',
      'shadow-auditor/tool-proposal/v1',
      'shadow-auditor/tool-decision/v1',
      'shadow-auditor/tool-grant/v1',
      'shadow-auditor/tool-result/v1',
      'shadow-auditor/event-envelope/v1',
    ],
    status: 'frozen',
  };
  const protocolDigest = digestJson(manifestProjection);
  const manifest = {...manifestProjection, protocolDigest};
  await writeOrCheck('protocol/manifest.json', pretty(manifest));
  console.log(`${check ? 'Verified' : 'Generated'} protocol ${protocolDigest}`);
}

await main();
