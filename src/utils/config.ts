import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Configuration interface for Shadow Auditor
 */
export interface ShadowConfig {
  apiKey: string;
  customBaseUrl?: string;
  model: string;
  provider: string;
}

const CONFIG_FILENAME = '.shadow-auditor.json';

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
    if (parsed.provider !== 'ollama' && !parsed.apiKey) {
      return null;
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
  const json = JSON.stringify(configData, null, 2);
  await fs.writeFile(configPath, json, 'utf-8');
}
