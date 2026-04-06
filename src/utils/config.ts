import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Configuration interface for Shadow Auditor
 */
export interface ShadowConfig {
  apiKey: string;
  auditMode?: 'balanced' | 'deep' | 'quick';
  commandPolicy?: {
    additionalAllowedCommandPatterns?: string[];
    additionalDeniedPatterns?: string[];
    allowPnpmYarn?: boolean;
  };
  continuation?: {
    maxContinuations?: number;
  };
  customBaseUrl?: string;
  expertUnsafe?: boolean;
  maxOutputTokens?: number;
  maxToolSteps?: number;
  mcp?: {
    adapters?: Array<'chrome-devtools' | 'kali-linux'>;
    chromeDevtoolsEndpoint?: string;
    enabled?: boolean;
    kaliLinuxEndpoint?: string;
  };
  model: string;
  provider: string;
  reportValidation?: {
    maxRepairRetries?: number;
  };
}

const CONFIG_FILENAME = '.shadow-auditor.json';
let plaintextApiKeyWarningShown = false;

/**
 * Extension point for future secure keychain integration.
 * Current behavior remains JSON-file based for backward compatibility.
 */
export interface SecretStoreAdapter {
  getApiKey(provider: string): Promise<null | string>;
  setApiKey?(provider: string, apiKey: string): Promise<void>;
}

let secretStoreAdapter: null | SecretStoreAdapter = null;

export function registerSecretStoreAdapter(adapter: SecretStoreAdapter): void {
  secretStoreAdapter = adapter;
}

/**
 * Resolves the absolute path to the global config file
 */
function getConfigPath(): string {
  return path.join(os.homedir(), CONFIG_FILENAME);
}

/**
 * Loads the Shadow Auditor configuration from ~/.shadow-auditor.json
 * Returns null if the file doesn't exist or is invalid
 */
export async function loadConfig(): Promise<null | ShadowConfig> {
  const configPath = getConfigPath();

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as ShadowConfig;

    // Validate essential fields
    if (!parsed.provider || !parsed.model) {
      return null;
    }

    // API key is required for non-Ollama providers
    if (parsed.provider !== 'ollama' && !parsed.apiKey && secretStoreAdapter) {
      const secureApiKey = await secretStoreAdapter.getApiKey(parsed.provider);
      if (secureApiKey) {
        parsed.apiKey = secureApiKey;
      }
    }

    if (parsed.provider !== 'ollama' && !parsed.apiKey) {
      return null;
    }

    if (parsed.provider !== 'ollama' && parsed.apiKey && !plaintextApiKeyWarningShown) {
      plaintextApiKeyWarningShown = true;
      console.warn(
        `[SHADOW-AUDITOR][WARN] API key is stored in plaintext at ${configPath}. ` +
          'Consider using environment variables or registerSecretStoreAdapter(...) for keychain integration.',
      );
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Saves the Shadow Auditor configuration to ~/.shadow-auditor.json
 */
export async function saveConfig(configData: ShadowConfig): Promise<void> {
  const configPath = getConfigPath();

  if (configData.provider !== 'ollama' && configData.apiKey && secretStoreAdapter?.setApiKey) {
    await secretStoreAdapter.setApiKey(configData.provider, configData.apiKey);

    const { apiKey: _apiKey, ...configWithoutApiKey } = configData;
    const json = JSON.stringify(configWithoutApiKey, null, 2);
    await fs.writeFile(configPath, json, 'utf-8');
    return;
  }

  const json = JSON.stringify(configData, null, 2);
  await fs.writeFile(configPath, json, 'utf-8');
}
