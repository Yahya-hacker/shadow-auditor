import { deletePassword, getPassword, setPassword } from 'cross-keychain';

import type { TokenSet } from '../protocol/generated.js';

const SERVICE_NAME = 'shadow-auditor';

export interface DeviceCredentials {
  deviceId: string;
  keyId: string;
  privateKeyPkcs8: string;
  publicKey: string;
  serverSigningKeys: Array<{
    algorithm: 'ed25519';
    keyId: string;
    publicKey: string;
  }>;
  tokens: TokenSet;
}

export interface CredentialStore {
  delete(account: string): Promise<void>;
  get(account: string): Promise<null | string>;
  set(account: string, value: string): Promise<void>;
}

export class CredentialStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialStoreError';
  }
}

export class KeychainCredentialStore implements CredentialStore {
  async delete(account: string): Promise<void> {
    try {
      await deletePassword(SERVICE_NAME, account);
    } catch (error) {
      throw new CredentialStoreError('Unable to delete credentials from the operating-system keychain', { cause: error });
    }
  }

  async get(account: string): Promise<null | string> {
    try {
      return await getPassword(SERVICE_NAME, account);
    } catch (error) {
      throw new CredentialStoreError('Unable to read credentials from the operating-system keychain', { cause: error });
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await setPassword(SERVICE_NAME, account, value);
    } catch (error) {
      throw new CredentialStoreError('Unable to store credentials in the operating-system keychain', { cause: error });
    }
  }
}

function parseCredentials(serialized: string): DeviceCredentials {
  const value = JSON.parse(serialized) as Partial<DeviceCredentials>;
  if (
    typeof value.deviceId !== 'string' ||
    typeof value.keyId !== 'string' ||
    typeof value.privateKeyPkcs8 !== 'string' ||
    typeof value.publicKey !== 'string' ||
    !Array.isArray(value.serverSigningKeys) ||
    typeof value.tokens !== 'object' ||
    value.tokens === null
  ) {
    throw new CredentialStoreError('Stored device credentials are malformed');
  }

  return value as DeviceCredentials;
}

export class DeviceCredentialVault {
  constructor(private readonly store: CredentialStore = new KeychainCredentialStore()) {}

  async delete(account: string): Promise<void> {
    await this.store.delete(account);
  }

  async load(account: string): Promise<DeviceCredentials> {
    const environmentCredentials = process.env.SHADOW_AUDITOR_DEVICE_CREDENTIALS;
    const serialized = environmentCredentials ?? (await this.store.get(account));
    if (!serialized) {
      throw new CredentialStoreError(`No device credentials found for account "${account}"`);
    }

    try {
      return parseCredentials(serialized);
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError('Stored device credentials are not valid JSON', { cause: error });
    }
  }

  async save(account: string, credentials: DeviceCredentials): Promise<void> {
    if (process.env.SHADOW_AUDITOR_DEVICE_CREDENTIALS) {
      throw new CredentialStoreError('Environment-supplied credentials are read-only and cannot be rotated');
    }

    await this.store.set(account, JSON.stringify(credentials));
  }
}

export async function deleteDeviceCredentials(
  account: string,
  store?: CredentialStore,
): Promise<void> {
  await new DeviceCredentialVault(store).delete(account);
}
