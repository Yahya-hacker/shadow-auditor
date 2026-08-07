import { randomUUID } from 'node:crypto';

import type { EventEnvelope, JsonObject, JsonValue, PublicKey } from '../src/protocol/generated.js';

import { createDeviceKeyPair, signCanonical } from '../src/core/remote/crypto.js';
import { sha256Digest } from '../src/protocol/canonical-json.js';
import {
  type CredentialStore,
  type DeviceCredentials,
  DeviceCredentialVault,
} from '../src/utils/keychain.js';

export class MemoryCredentialStore implements CredentialStore {
  value: null | string = null;

  async delete(): Promise<void> {
    this.value = null;
  }

  async get(): Promise<null | string> {
    return this.value;
  }

  async set(_account: string, value: string): Promise<void> {
    this.value = value;
  }
}

export function createDeviceCredentials(
  serverSigningKeys: PublicKey[] = [],
): DeviceCredentials {
  const pair = createDeviceKeyPair();
  const now = Date.now();
  return {
    deviceId: randomUUID(),
    keyId: pair.keyId,
    privateKeyPkcs8: pair.privateKeyPkcs8,
    publicKey: pair.publicKey,
    serverSigningKeys,
    tokens: {
      accessToken: 'old-access-token-value-000000000000',
      accessTokenExpiresAt: new Date(now + 60_000).toISOString(),
      refreshToken: 'refresh-token-value-0000000000000000',
      refreshTokenExpiresAt: new Date(now + 3_600_000).toISOString(),
      tokenType: 'Bearer',
    },
  };
}

export async function createTestVault(value: DeviceCredentials): Promise<{
  store: MemoryCredentialStore;
  vault: DeviceCredentialVault;
}> {
  const store = new MemoryCredentialStore();
  const vault = new DeviceCredentialVault(store);
  await vault.save('test', value);
  return { store, vault };
}

export function createEventSigner(): {
  privateKeyPkcs8: string;
  publicKey: PublicKey;
} {
  const pair = createDeviceKeyPair();
  return {
    privateKeyPkcs8: pair.privateKeyPkcs8,
    publicKey: {
      algorithm: 'ed25519',
      keyId: pair.keyId,
      publicKey: pair.publicKey,
    },
  };
}

export function createSignedEvent(options: {
  eventType?: EventEnvelope['eventType'];
  payload?: JsonObject;
  previousEventHash?: null | string;
  sequence?: number;
  sessionId?: string;
  signer: ReturnType<typeof createEventSigner>;
}): EventEnvelope {
  const payload = options.payload ?? {};
  const unsigned = {
    causationId: null,
    correlationId: randomUUID(),
    eventId: randomUUID(),
    eventType: options.eventType ?? 'heartbeat',
    occurredAt: new Date().toISOString(),
    payload,
    payloadDigest: sha256Digest(payload),
    previousEventHash: options.previousEventHash ?? null,
    protocolVersion: '1.0' as const,
    sequence: options.sequence ?? 1,
    sessionId: options.sessionId ?? randomUUID(),
    signer: options.signer.publicKey,
  };
  return {
    ...unsigned,
    eventHash: sha256Digest(unsigned as unknown as JsonValue),
    signature: signCanonical(unsigned as unknown as JsonValue, options.signer.privateKeyPkcs8),
  };
}

export function streamFromText(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
