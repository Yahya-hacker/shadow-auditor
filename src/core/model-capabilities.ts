import type { ShadowConfig } from '../utils/config.js';

export type AuditMode = 'balanced' | 'deep' | 'quick';

export interface ModelCapabilities {
  maxOutputTokens: number;
  maxToolSteps: number;
  preferredAuditMode: AuditMode;
  supportsLongOutput: boolean;
  supportsReasoningMode?: boolean;
}

interface CapabilityRule {
  capabilities: ModelCapabilities;
  modelPattern: RegExp;
  provider: string;
}

const FALLBACK_CAPABILITIES: ModelCapabilities = {
  maxOutputTokens: 16_000,
  maxToolSteps: 10,
  preferredAuditMode: 'balanced',
  supportsLongOutput: false,
  supportsReasoningMode: false,
};

const CAPABILITY_RULES: CapabilityRule[] = [
  // Anthropic (2026-generation models)
  {
    capabilities: {
      maxOutputTokens: 64_000,
      maxToolSteps: 22,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /claude-(opus|sonnet|haiku)-4\.5/i,
    provider: 'anthropic',
  },
  {
    capabilities: {
      maxOutputTokens: 64_000,
      maxToolSteps: 20,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /.*/,
    provider: 'anthropic',
  },

  // OpenAI / Codex family (2026 constraints requested by user)
  {
    capabilities: {
      maxOutputTokens: 48_000,
      maxToolSteps: 20,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /gpt-5\.3-codex/i,
    provider: 'openai',
  },
  {
    capabilities: {
      maxOutputTokens: 40_000,
      maxToolSteps: 18,
      preferredAuditMode: 'balanced',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /gpt-5\.(2|1)(-codex)?/i,
    provider: 'openai',
  },
  {
    capabilities: {
      maxOutputTokens: 32_000,
      maxToolSteps: 16,
      preferredAuditMode: 'balanced',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /gpt-5(\.4)?-mini/i,
    provider: 'openai',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: 12,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'openai',
  },

  // Other providers (safe but practical defaults)
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: 12,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'google',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: 12,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: true,
    },
    modelPattern: /.*/,
    provider: 'mistral',
  },
  {
    capabilities: {
      maxOutputTokens: 8_000,
      maxToolSteps: 10,
      preferredAuditMode: 'quick',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'ollama',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: 10,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'custom',
  },
];

export interface RuntimeSettings {
  capabilities: ModelCapabilities;
  maxOutputTokens: number;
  maxToolSteps: number;
}

function toPositiveInteger(value: unknown): null | number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return null;
  }

  return normalized;
}

export function resolveModelCapabilities(config: Pick<ShadowConfig, 'model' | 'provider'>): ModelCapabilities {
  const provider = config.provider.trim().toLowerCase();
  const model = config.model.trim();

  const matchedRule = CAPABILITY_RULES.find((rule) => rule.provider === provider && rule.modelPattern.test(model));
  if (!matchedRule) {
    return FALLBACK_CAPABILITIES;
  }

  return matchedRule.capabilities;
}

export function effectiveMaxOutputTokens(
  config: Pick<ShadowConfig, 'maxOutputTokens' | 'model' | 'provider'>,
  onWarning?: (message: string) => void,
): number {
  const modelCapabilities = resolveModelCapabilities(config);
  const requested = toPositiveInteger(config.maxOutputTokens);
  if (requested === null) {
    return modelCapabilities.maxOutputTokens;
  }

  if (requested > modelCapabilities.maxOutputTokens) {
    onWarning?.(`Requested max output tokens exceeds model limit; clamped to ${modelCapabilities.maxOutputTokens}.`);
    return modelCapabilities.maxOutputTokens;
  }

  return requested;
}

export function effectiveMaxToolSteps(
  config: Pick<ShadowConfig, 'maxToolSteps' | 'model' | 'provider'>,
): number {
  const modelCapabilities = resolveModelCapabilities(config);
  const requested = toPositiveInteger(config.maxToolSteps);
  if (requested === null) {
    return modelCapabilities.maxToolSteps;
  }

  return Math.min(requested, modelCapabilities.maxToolSteps);
}

export function resolveRuntimeSettings(
  config: Pick<ShadowConfig, 'maxOutputTokens' | 'maxToolSteps' | 'model' | 'provider'>,
  onWarning?: (message: string) => void,
): RuntimeSettings {
  const capabilities = resolveModelCapabilities(config);
  return {
    capabilities,
    maxOutputTokens: effectiveMaxOutputTokens(config, onWarning),
    maxToolSteps: effectiveMaxToolSteps(config),
  };
}
