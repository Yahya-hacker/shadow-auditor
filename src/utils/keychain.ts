/**
 * Credential Vault — OS Keychain Adapter with Environment Variable Fallback.
 *
 * Implements SecretStoreAdapter using a three-tier resolution chain:
 *   1. OS Keychain (cross-keychain): macOS Keychain, Windows Credential Manager, Linux Secret Service
 *   2. Environment Variables: SHADOW_{PROVIDER}_KEY (e.g. SHADOW_OPENAI_KEY)
 *   3. Plaintext config (handled transparently by config.ts when no adapter resolves)
 *
 * On headless CI/Linux without a desktop secret service, the keychain import
 * fails gracefully and the adapter falls through to env vars — never crashes.
 */

import type { SecretStoreAdapter } from './config.js';

// =============================================================================
// Constants
// =============================================================================

const SERVICE_NAME = 'shadow-auditor';

/** Maps provider names to their conventional environment variable names. */
const ENV_VAR_MAP: Record<string, string> = {
  anthropic: 'SHADOW_ANTHROPIC_KEY',
  custom: 'SHADOW_CUSTOM_KEY',
  google: 'SHADOW_GOOGLE_KEY',
  mistral: 'SHADOW_MISTRAL_KEY',
  ollama: 'SHADOW_OLLAMA_KEY',
  openai: 'SHADOW_OPENAI_KEY',
};

// =============================================================================
// Keychain Bindings (lazy, crash-safe)
// =============================================================================

interface KeychainModule {
  deletePassword(service: string, account: string): Promise<boolean>;
  getPassword(service: string, account: string): Promise<null | string>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let keychainModule: KeychainModule | null = null;
let keychainLoadAttempted = false;

/**
 * Lazily attempt to load cross-keychain.
 * Returns null if the module is unavailable or the OS backend fails.
 */
async function getKeychainModule(): Promise<KeychainModule | null> {
  if (keychainLoadAttempted) return keychainModule;
  keychainLoadAttempted = true;

  try {
    // Dynamic import so the CLI doesn't crash if cross-keychain isn't installed
    // or if the OS has no secret service daemon running.
    // Use a variable to prevent TypeScript from resolving the module at compile time.
    const moduleName = 'cross-keychain';
    const mod = await import(/* webpackIgnore: true */ moduleName) as KeychainModule;
    keychainModule = mod;
    return keychainModule;
  } catch {
    // Expected on headless CI, Docker, Alpine Linux, etc.
    return null;
  }
}

// =============================================================================
// Environment Variable Resolver
// =============================================================================

function getApiKeyFromEnv(provider: string): null | string {
  const envVar = ENV_VAR_MAP[provider.toLowerCase()];
  if (!envVar) return null;

  const value = process.env[envVar];
  return value?.trim() || null;
}

// =============================================================================
// KeychainAdapter
// =============================================================================

/**
 * Production-grade SecretStoreAdapter.
 *
 * Resolution order for getApiKey:
 *   1. OS Keychain (if available)
 *   2. Environment variable (SHADOW_{PROVIDER}_KEY)
 *   3. Returns null → config.ts falls back to plaintext JSON
 *
 * setApiKey always tries the OS keychain first; silently skips on failure.
 */
export class KeychainAdapter implements SecretStoreAdapter {
  /**
   * Retrieve an API key for the given provider.
   */
  async getApiKey(provider: string): Promise<null | string> {
    // 1. Try OS keychain
    const keychain = await getKeychainModule();
    if (keychain) {
      try {
        const secret = await keychain.getPassword(SERVICE_NAME, `apiKey-${provider}`);
        if (secret) return secret;
      } catch {
        // Keychain access denied or corrupt — fall through
      }
    }

    // 2. Try environment variable
    return getApiKeyFromEnv(provider);
  }

  /**
   * Store an API key in the OS keychain.
   * Silently no-ops if the keychain is unavailable.
   */
  async setApiKey(provider: string, apiKey: string): Promise<void> {
    const keychain = await getKeychainModule();
    if (!keychain) return;

    try {
      await keychain.setPassword(SERVICE_NAME, `apiKey-${provider}`, apiKey);
    } catch {
      // Cannot write to keychain — user will fall back to plaintext JSON
    }
  }
}

// =============================================================================
// Exports for testing
// =============================================================================

export { ENV_VAR_MAP, getApiKeyFromEnv, SERVICE_NAME };
