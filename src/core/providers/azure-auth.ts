import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

import {
  type AzureProviderConfig,
  resolveAzureTokenScope,
} from '../../utils/azure-provider.js';

const credentials = new Map<string, TokenCredential>();

function credentialKey(config: AzureProviderConfig): string {
  return [
    config.credentialMode ?? 'default',
    config.managedIdentityClientId ?? '',
  ].join(':');
}

function createCredential(config: AzureProviderConfig): TokenCredential {
  if (config.credentialMode === 'managed-identity') {
    return config.managedIdentityClientId
      ? new ManagedIdentityCredential({clientId: config.managedIdentityClientId})
      : new ManagedIdentityCredential();
  }

  return new DefaultAzureCredential({
    managedIdentityClientId: config.managedIdentityClientId,
  });
}

export function createAzureTokenProvider(
  config: AzureProviderConfig,
): () => Promise<string> {
  const key = credentialKey(config);
  let credential = credentials.get(key);
  if (!credential) {
    credential = createCredential(config);
    credentials.set(key, credential);
  }

  const scope = resolveAzureTokenScope(config);
  return async () => {
    const token = await credential.getToken(scope);
    if (!token?.token) {
      throw new Error(`Microsoft Entra authentication returned no token for scope ${scope}.`);
    }

    return token.token;
  };
}
