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

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

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
  const snapshotCursorProjection = {
    collection: 'operations',
    collectionDigest: snapshotCollectionDigest,
    expiresAt: '2026-01-02T03:24:08.000Z',
    limitProfileDigest,
    nextOffset: 128,
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
    'protocol/openapi.json',
    ...schemaNames.map((name) => `protocol/schemas/${name}`),
    'protocol/signing-vectors.json',
    'scripts/generate-protocol.mjs',
    'src/protocol/canonical-json.ts',
    'src/protocol/generated/dtos.ts',
    'src/protocol/index.ts',
    'src/protocol/negotiated-limits.ts',
    'src/protocol/signing.ts',
  ].sort();
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

async function main() {
  const schemas = await readSchemas();
  const featureEnum = schemas.get('capabilities.schema.json')?.$defs?.Feature?.enum;
  if (!Array.isArray(featureEnum)) {
    throw new TypeError('Capability feature enum is missing');
  }

  for (const feature of REQUIRED_FEATURES) {
    if (!featureEnum.includes(feature)) {
      throw new Error(`Manifest feature is not negotiable: ${feature}`);
    }
  }

  const schemaNames = [...schemas.keys()];
  const normalizedJson = new Map();
  for (const name of schemaNames) {
    normalizedJson.set(`protocol/schemas/${name}`, pretty(schemas.get(name)));
  }

  const openapi = JSON.parse(await readFile(path.join(root, 'protocol', 'openapi.json'), 'utf8'));
  normalizedJson.set('protocol/openapi.json', pretty(openapi));
  normalizedJson.set('protocol/signing-vectors.json', pretty(generateVectors()));

  for (const [relativePath, contents] of normalizedJson) {
    await writeOrCheck(relativePath, contents);
  }

  await writeOrCheck('src/protocol/generated/dtos.ts', generateDtos(schemas));

  const files = [];
  for (const relativePath of await collectManifestFiles(schemaNames)) {
    const contents = normalizedUtf8Bytes(await readFile(path.join(root, relativePath), 'utf8'));
    files.push({
      bytes: contents.byteLength,
      path: relativePath.replaceAll('\\', '/'),
      sha256: sha256(contents),
    });
  }

  const manifestProjection = {
    canonicalJson: {
      limitInvariants: {
        minimumArrayItems: 7,
        minimumObjectKeys: 32,
        minimumRecoveryPageOverheadBytes: 16_384,
        minimumRecoveryPageOverheadNodes: 256,
        minimumStringBytes: 128,
        profileDigestSemantics: 'SHA-256 over strict canonical JSON of the complete effective limits object.',
        recoveryPageDepthOverhead: 2,
        semanticValidator: 'negotiateProtocolLimits',
        toolProposalEventOverheadBytes: 16_384,
        toolProposalEventOverheadNodes: 256,
        toolProposalItemOverheadBytes: 4096,
        toolProposalItemOverheadNodes: 64,
      },
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
        maxToolArgumentsBytes: 245_760,
        maxToolDescriptors: 128,
        maxToolResultValueBytes: 524_288,
      },
      profile: 'RFC 8785 JCS over strict I-JSON',
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
