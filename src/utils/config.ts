import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { writeFileAtomic } from './fs-atomic.js';

const CONFIG_FILE_MODE_MASK = 0o077; // Bits that should NOT be set for config file

/**
 * Configuration interface for Shadow Auditor
 */
export interface ShadowConfig {
  apiKey: string;
  auditMode?: 'balanced' | 'deep' | 'deep-sast' | 'full-report' | 'patch-only' | 'quick' | 'triage';
  /** CI mode: produce deterministic machine outputs, exit non-zero on threshold */
  ci?: {
    enabled?: boolean;
    /** Minimum severity that causes a non-zero exit. Default: "high". */
    failOn?: 'critical' | 'high' | 'info' | 'low' | 'medium' | 'none';
  };
  commandPolicy?: {
    additionalAllowedCommandPatterns?: string[];
    additionalDeniedPatterns?: string[];
    allowPnpmYarn?: boolean;
  };
  continuation?: {
    maxContinuations?: number;
  };
  customBaseUrl?: string;
  dast?: {
    baseImage?: string;
    cpuLimit?: string;
    enabled?: boolean;
    healthCheckUrl?: string;
    memoryLimit?: string;
    startCommand?: string;
  };
  /** Incremental diff mode: scope analysis to files changed since this ref */
  diff?: {
    baseRef?: string;
    enabled?: boolean;
  };
  expertUnsafe?: boolean;
  /** Semantic indexing configuration for hybrid code retrieval */
  indexing?: {
    /** Chunking strategy: 'function' (default), 'class', or 'file' */
    chunkStrategy?: 'class' | 'file' | 'function';
    /** Embedding model name. Defaults are auto-selected from the main provider when supported. */
    embeddingModel?: string;
    /** Embedding provider: 'ollama' (local) or 'openai' (OpenAI-compatible embeddings API). */
    embeddingProvider?: 'ollama' | 'openai';
    /** Enable semantic indexing (default: true when embedding provider is available) */
    enabled?: boolean;
    /** Maximum characters per code chunk (default: 4000) */
    maxChunkChars?: number;
  };
  licenseKey?: string;
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
  remediation?: {
    autoRevert?: boolean;
    containerImage?: string;
    enabled?: boolean;
    testCommand?: string;
    testTimeoutMs?: number;
  };
  reportValidation?: {
    maxRepairRetries?: number;
  };
  swarm?: {
    enabled?: boolean;
    maxWorkers?: number;
    modelOverrides?: Record<string, { apiKey?: string; model: string; provider: string }>;
    roles?: string[];
    workerBudgetRatio?: number;
  };
}

const CONFIG_FILENAME = '.shadow-auditor.json';
let plaintextApiKeyWarningShown = false;

const shadowConfigSchema = z.object({
  apiKey: z.string().optional().default(''),
  auditMode: z.enum(['balanced', 'deep', 'deep-sast', 'full-report', 'patch-only', 'quick', 'triage']).optional(),
  ci: z.object({
    enabled: z.boolean().optional(),
    failOn: z.enum(['critical', 'high', 'info', 'low', 'medium', 'none']).optional(),
  }).optional(),
  commandPolicy: z.object({
    additionalAllowedCommandPatterns: z.array(z.string()).optional(),
    additionalDeniedPatterns: z.array(z.string()).optional(),
    allowPnpmYarn: z.boolean().optional(),
  }).optional(),
  continuation: z.object({
    maxContinuations: z.number().int().optional(),
  }).optional(),
  customBaseUrl: z.string().optional(),
  dast: z.object({
    baseImage: z.string().optional(),
    cpuLimit: z.string().optional(),
    enabled: z.boolean().optional(),
    healthCheckUrl: z.string().optional(),
    memoryLimit: z.string().optional(),
    startCommand: z.string().optional(),
  }).optional(),
  diff: z.object({
    baseRef: z.string().optional(),
    enabled: z.boolean().optional(),
  }).optional(),
  expertUnsafe: z.boolean().optional(),
  indexing: z.object({
    chunkStrategy: z.enum(['class', 'file', 'function']).optional(),
    embeddingModel: z.string().optional(),
    embeddingProvider: z.enum(['ollama', 'openai']).optional(),
    enabled: z.boolean().optional(),
    maxChunkChars: z.number().int().optional(),
  }).optional(),
  licenseKey: z.string().optional(),
  maxOutputTokens: z.number().int().optional(),
  maxToolSteps: z.number().int().optional(),
  mcp: z.object({
    adapters: z.array(z.enum(['chrome-devtools', 'kali-linux'])).optional(),
    chromeDevtoolsEndpoint: z.string().optional(),
    enabled: z.boolean().optional(),
    kaliLinuxEndpoint: z.string().optional(),
  }).optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  remediation: z.object({
    autoRevert: z.boolean().optional(),
    containerImage: z.string().optional(),
    enabled: z.boolean().optional(),
    testCommand: z.string().optional(),
    testTimeoutMs: z.number().int().optional(),
  }).optional(),
  reportValidation: z.object({
    maxRepairRetries: z.number().int().optional(),
  }).optional(),
  swarm: z.object({
    enabled: z.boolean().optional(),
    maxWorkers: z.number().int().optional(),
    modelOverrides: z.record(z.object({
      apiKey: z.string().optional(),
      model: z.string(),
      provider: z.string(),
    })).optional(),
    roles: z.array(z.string()).optional(),
    workerBudgetRatio: z.number().optional(),
  }).optional(),
});

export type ValidShadowConfig = z.infer<typeof shadowConfigSchema>;

export function validateConfig(data: unknown): null | ShadowConfig {
  const result = shadowConfigSchema.safeParse(data);
  if (!result.success) {
    process.stderr.write(`[ShadowAuditor][WARN] Invalid config: ${result.error.message}\n`);
    return null;
  }

  return result.data as ShadowConfig;
}

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
    const parsedRaw = JSON.parse(raw) as unknown;
    const parsed = validateConfig(parsedRaw);
    if (!parsed) {
      return null;
    }

    // Check file permissions: warn if config file is readable by group/others
    try {
      const stat = await fs.stat(configPath);
      if ((stat.mode & CONFIG_FILE_MODE_MASK) !== 0) {
        process.stderr.write(
          `[ShadowAuditor][WARN] Config file at ${configPath} has overly permissive permissions ` +
          `(${(stat.mode & 0o777).toString(8)}). It contains your API key. ` +
          `Run: chmod 600 ${configPath} to secure it.\n`,
        );
      }
    } catch {
      // Stat failed — file may have been deleted between read and stat; non-fatal
    }

    // Track if API key was in plaintext config (for warning)
    const hadPlaintextApiKey = parsed.apiKey !== '';

    // API key is required for non-Ollama providers
    if (parsed.provider !== 'ollama' && !parsed.apiKey && secretStoreAdapter) {
      const secureApiKey = await secretStoreAdapter.getApiKey(parsed.provider);
      if (secureApiKey) {
        parsed.apiKey = secureApiKey;
      }
    }

    if (parsed.provider !== 'ollama' && !parsed.apiKey) {
      process.stderr.write(
        `[ShadowAuditor][WARN] No API key configured for provider "${parsed.provider}". ` +
        'Run with --reconfigure to set up your API key, or switch to Ollama with --provider ollama.\n',
      );
      return null;
    }

    // Only warn if the API key was actually stored in plaintext config
    if (hadPlaintextApiKey && !plaintextApiKeyWarningShown) {
      plaintextApiKeyWarningShown = true;
      process.stderr.write(
        `[ShadowAuditor][WARN] API key is stored in plaintext at ${configPath}. ` +
          'Consider using environment variables or the setup wizard for secure keychain storage.\n',
      );
    }

    return parsed;
  } catch (error) {
    // Distinguish between "file not found" (normal first run) and actual errors
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    const message = error instanceof SyntaxError
      ? `Config file is corrupt (invalid JSON) at ${configPath}. Run with --reconfigure to reset.`
      : `Cannot read config file at ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`[ShadowAuditor][ERROR] ${message}\n`);
    return null;
  }
}

/**
 * Saves the Shadow Auditor configuration to ~/.shadow-auditor.json
 */
export async function saveConfig(configData: ShadowConfig): Promise<void> {
  const configPath = getConfigPath();

  if (configData.provider !== 'ollama' && configData.apiKey && secretStoreAdapter?.setApiKey) {
    // Try keychain first. If it fails, keep the API key in the config file
    // as a fallback rather than silently losing it.
    let keychainOk = false;
    try {
      await secretStoreAdapter.setApiKey(configData.provider, configData.apiKey);
      keychainOk = true;
    } catch {
      process.stderr.write(
        `[ShadowAuditor][WARN] Failed to store API key in OS keychain. ` +
        'Keeping key in config file as fallback.\n',
      );
    }

    if (keychainOk) {
      // Keychain succeeded — strip API key from plaintext config
      const { apiKey: _apiKey, ...configWithoutApiKey } = configData;
      const json = JSON.stringify(configWithoutApiKey, null, 2);
      await writeFileAtomic(configPath, json);
      return;
    }
    // Fall through to plaintext write with API key included
  }

  const json = JSON.stringify(configData, null, 2);
  await writeFileAtomic(configPath, json);
}
