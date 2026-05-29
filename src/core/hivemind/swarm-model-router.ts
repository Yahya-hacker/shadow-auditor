/**
 * Swarm Model Router - Role-aware model resolution with epistemic trust tiers.
 *
 * Enables heterogeneous model assignment per worker role in the swarm.
 * Each role can be assigned a different LLM provider/model combination,
 * and the system automatically classifies the model's epistemic trust tier
 * for cross-agent claim filtering.
 */

import { type LanguageModel } from 'ai';

import { type ShadowConfig } from '../../utils/config.js';
import { getModel } from '../model-router.js';
import { type AgentRole, type ModelTier } from './hivemind-schema.js';

// =============================================================================
// Model Override Types
// =============================================================================

export interface ModelOverride {
  apiKey?: string;
  model: string;
  provider: string;
}

export type SwarmModelOverrides = Partial<Record<AgentRole, ModelOverride>>;

// =============================================================================
// Trust Tier Classification
// =============================================================================

/**
 * Premium model patterns by provider.
 * Premium models have deep reasoning, long context, and high accuracy.
 */
const PREMIUM_PATTERNS: Array<{ modelPattern: RegExp; provider: string }> = [
  // Anthropic flagship
  { modelPattern: /claude-(opus|sonnet)-4/i, provider: 'anthropic' },
  { modelPattern: /claude-3\.5-sonnet/i, provider: 'anthropic' },
  // OpenAI flagship
  { modelPattern: /gpt-5/i, provider: 'openai' },
  { modelPattern: /gpt-4o(?!-mini)/i, provider: 'openai' },
  { modelPattern: /o[1-4]-/i, provider: 'openai' },
  // Google flagship
  { modelPattern: /gemini-(2|3)\.\d-(pro|ultra)/i, provider: 'google' },
  // Mistral flagship
  { modelPattern: /mistral-large/i, provider: 'mistral' },
];

/**
 * Standard model patterns — capable but not top-tier.
 */
const STANDARD_PATTERNS: Array<{ modelPattern: RegExp; provider: string }> = [
  { modelPattern: /claude-haiku/i, provider: 'anthropic' },
  { modelPattern: /gpt-4o-mini/i, provider: 'openai' },
  { modelPattern: /gpt-4-turbo/i, provider: 'openai' },
  { modelPattern: /gemini-(2|3)\.\d-flash/i, provider: 'google' },
  { modelPattern: /mistral-(medium|small)/i, provider: 'mistral' },
];

/**
 * Classify a model into an epistemic trust tier.
 *
 * - `premium` (trust 0.9): Flagship models with deep reasoning.
 * - `standard` (trust 0.7): Capable mid-tier models.
 * - `local` (trust 0.5): Ollama/custom models, unknown quality.
 */
export function classifyModelTier(provider: string, model: string): ModelTier {
  const normalizedProvider = provider.trim().toLowerCase();

  // Ollama and custom endpoints are always local tier
  if (normalizedProvider === 'ollama' || normalizedProvider === 'custom') {
    return 'local';
  }

  // Check premium patterns
  for (const rule of PREMIUM_PATTERNS) {
    if (rule.provider === normalizedProvider && rule.modelPattern.test(model)) {
      return 'premium';
    }
  }

  // Check standard patterns
  for (const rule of STANDARD_PATTERNS) {
    if (rule.provider === normalizedProvider && rule.modelPattern.test(model)) {
      return 'standard';
    }
  }

  // Unknown models from known providers default to standard
  if (['anthropic', 'google', 'mistral', 'openai'].includes(normalizedProvider)) {
    return 'standard';
  }

  return 'local';
}

/**
 * Compute the trust score for a given model tier.
 */
export function computeTrustScore(tier: ModelTier): number {
  switch (tier) {
    case 'local': {
      return 0.5;
    }

    case 'premium': {
      return 0.9;
    }

    case 'standard': {
      return 0.7;
    }
  }
}

// =============================================================================
// Model Resolution
// =============================================================================

/** Cache to avoid re-creating provider clients for the same model. */
const modelCache = new Map<string, LanguageModel>();

function cacheKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}:${model.trim()}`;
}

/**
 * Resolve the LanguageModel for a given worker role.
 *
 * If `overrides[role]` is defined, instantiate a dedicated model for that role.
 * Otherwise, fall back to the shared default model.
 */
export function resolveWorkerModel(
  role: AgentRole,
  defaultModel: LanguageModel,
  overrides?: SwarmModelOverrides,
): LanguageModel {
  if (!overrides) {
    return defaultModel;
  }

  const override = overrides[role];
  if (!override) {
    return defaultModel;
  }

  const key = cacheKey(override.provider, override.model);
  const cached = modelCache.get(key);
  if (cached) {
    return cached;
  }

  const config: ShadowConfig = {
    apiKey: override.apiKey ?? '',
    model: override.model,
    provider: override.provider,
  };

  const model = getModel(config);
  modelCache.set(key, model);
  return model;
}

/**
 * Resolve model tier information for a given role.
 */
export function resolveWorkerTier(
  role: AgentRole,
  defaultProvider: string,
  defaultModelName: string,
  overrides?: SwarmModelOverrides,
): { modelTier: ModelTier; trustScore: number } {
  const override = overrides?.[role];
  const provider = override?.provider ?? defaultProvider;
  const model = override?.model ?? defaultModelName;

  const modelTier = classifyModelTier(provider, model);
  const trustScore = computeTrustScore(modelTier);

  return { modelTier, trustScore };
}

/**
 * Clear the model cache. Used in tests.
 */
export function clearModelCache(): void {
  modelCache.clear();
}
