import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type AuditMode = 'audit' | 'bounty' | 'ctf';

export interface ShadowConfig {
  auditMode: AuditMode;
  backendUrl: string;
  ci?: {
    failOnSeverity?: 'critical' | 'high' | 'low' | 'medium' | 'none';
    outputDir?: string;
  };
  commandPolicy?: {
    allowlist?: string[];
    denylist?: string[];
    expertUnsafe?: boolean;
  };
  credentialAccount: string;
  dast?: {
    allowedHosts?: string[];
    enabled?: boolean;
    maxRequests?: number;
    maxRuntimeMs?: number;
  };
  deviceName: string;
  diff?: {
    baseRef?: string;
    enabled?: boolean;
  };
  indexing?: {
    embeddingProvider?: 'none' | 'ollama';
    ollamaBaseUrl?: string;
    ollamaModel?: string;
  };
  licensing?: {
    mode?: 'bounty' | 'client' | 'ctf';
    proofPath?: string;
    target?: string;
  };
  mcp?: {
    adapters?: string[];
    chromeDevtoolsEndpoint?: string;
    enabled?: boolean;
    kaliLinuxEndpoint?: string;
  };
  remediation?: {
    enabled?: boolean;
    testCommand?: string;
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.shadow-auditor');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function isAuditMode(value: unknown): value is AuditMode {
  return value === 'audit' || value === 'bounty' || value === 'ctf';
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<null | ShadowConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    if (
      !isHttpsUrl(parsed.backendUrl) ||
      typeof parsed.credentialAccount !== 'string' ||
      parsed.credentialAccount.length === 0 ||
      typeof parsed.deviceName !== 'string' ||
      parsed.deviceName.length === 0 ||
      !isAuditMode(parsed.auditMode)
    ) {
      return null;
    }

    return parsed as unknown as ShadowConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function saveConfig(config: ShadowConfig): Promise<void> {
  if (!isHttpsUrl(config.backendUrl)) {
    throw new Error('Backend URL must use HTTPS');
  }

  await fs.mkdir(CONFIG_DIR, { mode: 0o700, recursive: true });
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, CONFIG_PATH);
}

export async function deleteConfig(): Promise<void> {
  try {
    await fs.unlink(CONFIG_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function isConfigured(config: null | ShadowConfig): config is ShadowConfig {
  return config !== null;
}

export function configExists(): Promise<boolean> {
  return fs
    .access(CONFIG_PATH)
    .then(() => true)
    .catch(() => false);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
