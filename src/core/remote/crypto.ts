import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';

import type {
  EventEnvelope,
  JsonObject,
  JsonValue,
  PublicKey,
  SignedRequestMetadata,
} from '../../protocol/generated.js';

import { canonicalJsonBytes, sha256Digest } from '../../protocol/canonical-json.js';
import { problem, ProtocolError } from './protocol-error.js';

export function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function createDeviceKeyPair(): {
  keyId: string;
  privateKeyPkcs8: string;
  publicKey: string;
} {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId: randomUUID(),
    privateKeyPkcs8: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: (() => {
      const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
      if (!publicKey) throw new Error('Generated Ed25519 public key is missing its x coordinate');
      return publicKey;
    })(),
  };
}

function privateKeyFromBase64(privateKeyPkcs8: string) {
  return createPrivateKey({
    format: 'der',
    key: Buffer.from(privateKeyPkcs8, 'base64url'),
    type: 'pkcs8',
  });
}

function publicKeyFromBase64(publicKey: string) {
  return createPublicKey({
    format: 'jwk',
    key: { crv: 'Ed25519', kty: 'OKP', x: publicKey },
  });
}

export function signCanonical(value: JsonValue, privateKeyPkcs8: string): string {
  return base64UrlEncode(sign(null, canonicalJsonBytes(value), privateKeyFromBase64(privateKeyPkcs8)));
}

export function verifyCanonical(value: JsonValue, signature: string, publicKey: string): boolean {
  return verify(
    null,
    canonicalJsonBytes(value),
    publicKeyFromBase64(publicKey),
    Buffer.from(signature, 'base64url'),
  );
}

export function createSignedRequest<T extends JsonObject>(
  payload: T,
  options: {
    deviceId: string;
    keyId: string;
    method: string;
    path: string;
    privateKeyPkcs8: string;
  },
): T & { request: SignedRequestMetadata } {
  const requestId = randomUUID();
  const timestamp = new Date().toISOString();
  const bodyDigest = sha256Digest(payload);
  const requestSigningPayload: JsonObject = {
    bodyDigest,
    deviceId: options.deviceId,
    keyId: options.keyId,
    method: options.method.toUpperCase(),
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(24))),
    path: options.path,
    protocolVersion: '1.0',
    requestId,
    signatureAlgorithm: 'ed25519',
    timestamp,
  };
  return {
    ...payload,
    request: {
      ...requestSigningPayload,
      signature: signCanonical(requestSigningPayload, options.privateKeyPkcs8),
    } as SignedRequestMetadata,
  };
}

export interface EventChainState {
  eventHash: null | string;
  sequence: number;
}

export function validateEventEnvelope(
  envelope: EventEnvelope,
  state: EventChainState,
  trustedKeys: PublicKey[],
  maxPayloadBytes: number,
): EventChainState {
  const payloadBytes = canonicalJsonBytes(envelope.payload);
  if (payloadBytes.byteLength > maxPayloadBytes) {
    throw new ProtocolError(problem({
      code: 'PAYLOAD_TOO_LARGE',
      detail: `Event payload is ${payloadBytes.byteLength} bytes; limit is ${maxPayloadBytes}`,
      status: 413,
      title: 'Event payload exceeds negotiated limit',
    }));
  }

  if (sha256Digest(envelope.payload) !== envelope.payloadDigest) {
    throw new ProtocolError(problem({
      code: 'PAYLOAD_DIGEST_MISMATCH',
      detail: `Event ${envelope.eventId} payload digest is invalid`,
      status: 400,
      title: 'Invalid event payload digest',
    }));
  }

  if (envelope.sequence !== state.sequence + 1) {
    throw new ProtocolError(problem({
      code: 'EVENT_SEQUENCE_GAP',
      detail: `Expected sequence ${state.sequence + 1}, received ${envelope.sequence}`,
      status: 409,
      title: 'Event sequence is not contiguous',
    }));
  }

  if (envelope.previousEventHash !== state.eventHash) {
    throw new ProtocolError(problem({
      code: 'EVENT_CHAIN_MISMATCH',
      detail: `Event ${envelope.eventId} does not extend the durable event chain`,
      status: 409,
      title: 'Invalid event hash chain',
    }));
  }

  const signingKey = trustedKeys.find(
    (key) => key.keyId === envelope.signer.keyId && key.algorithm === envelope.signer.algorithm,
  );
  if (!signingKey) {
    throw new ProtocolError(problem({
      code: 'UNTRUSTED_SIGNING_KEY',
      detail: `Event ${envelope.eventId} uses unknown signing key ${envelope.signer.keyId}`,
      status: 401,
      title: 'Untrusted event signer',
    }));
  }

  const { eventHash, signature, ...unsigned } = envelope;
  const computedHash = sha256Digest(unsigned as unknown as JsonValue);
  if (computedHash !== eventHash || !verifyCanonical(unsigned as unknown as JsonValue, signature, signingKey.publicKey)) {
    throw new ProtocolError(problem({
      code: 'INVALID_EVENT_SIGNATURE',
      detail: `Event ${envelope.eventId} failed hash or Ed25519 signature verification`,
      status: 401,
      title: 'Invalid signed event',
    }));
  }

  return { eventHash, sequence: envelope.sequence };
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
