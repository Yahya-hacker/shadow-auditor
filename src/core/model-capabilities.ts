import { EventEmitter } from 'node:events';
import { z } from 'zod';

import type { ShadowConfig } from '../utils/config.js';

import { SCHEMA_VERSION } from './schema/base.js';

export type AuditMode =
  | 'balanced'       // Legacy alias (maps to deep-sast behaviour internally)
  | 'deep'           // Legacy alias (maps to deep-sast behaviour internally)
  | 'deep-sast'      // Full analysis, more retrieval and verification
  | 'full-report'    // deep-sast + report enrichment and formatting
  | 'patch-only'     // Only produce patches/fixes + minimal narrative
  | 'quick'          // Legacy alias (maps to triage behaviour internally)
  | 'triage';        // Fast, fewer tools, minimal retrieval

export const budgetStatusSchema = z.object({
  continuationRequired: z.boolean(),
  exhaustionReason: z.string().optional(),
  isExhausted: z.boolean(),
  lastUpdatedAt: z.string().datetime(),
  outputTokensBudget: z.number().int().positive(),
  outputTokensPercent: z.number().min(0).max(100),
  outputTokensRemaining: z.number().int(),
  outputTokensUsed: z.number().int().nonnegative(),
  runId: z.string(),
  schemaVersion: z.string().default(SCHEMA_VERSION),
  startedAt: z.string().datetime(),
  toolStepsBudget: z.number().int().positive(),
  toolStepsPercent: z.number().min(0).max(100),
  toolStepsRemaining: z.number().int(),
  toolStepsUsed: z.number().int().nonnegative(),
});

export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export const continuationStrategySchema = z.enum([
  'checkpoint_and_resume',  // Save checkpoint, expect manual resume
  'auto_continue',          // Automatically continue in new context
  'graceful_stop',          // Finish current task, don't start new ones
  'hard_stop',              // Stop immediately, save state
]);

export type ContinuationStrategy = z.infer<typeof continuationStrategySchema>;

export interface ModelCapabilities {
  /** Maximum combined input and output context, when known. */
  contextWindowTokens?: number;
  /** Continuation strategy when budget is exhausted */
  continuationStrategy?: ContinuationStrategy;
  maxOutputTokens: number;
  /** Recommended maximum model/tool iterations. Parallel calls within one iteration count once. */
  maxToolSteps: number;
  preferredAuditMode: AuditMode;
  /** Whether model supports context caching */
  supportsContextCaching?: boolean;
  supportsLongOutput: boolean;
  supportsReasoningMode?: boolean;
}

interface CapabilityRule {
  capabilities: ModelCapabilities;
  modelPattern: RegExp;
  provider: string;
}

export const DEFAULT_MAX_TOOL_STEPS = 128;
export const ABSOLUTE_MAX_TOOL_STEPS = 1024;

const FALLBACK_CAPABILITIES: ModelCapabilities = {
  contextWindowTokens: 64_000,
  maxOutputTokens: 16_000,
  maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
  preferredAuditMode: 'balanced',
  supportsLongOutput: false,
  supportsReasoningMode: false,
};

const CAPABILITY_RULES: CapabilityRule[] = [
  // Anthropic (2026-generation models)
  {
    capabilities: {
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: false,
    },
    modelPattern: /claude-(opus|sonnet|haiku)-4\.5/i,
    provider: 'anthropic',
  },
  {
    capabilities: {
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'anthropic',
  },

  // Azure OpenAI / Microsoft Foundry deployment families
  {
    capabilities: {
      contextWindowTokens: 1_000_000,
      continuationStrategy: 'auto_continue',
      maxOutputTokens: 128_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep-sast',
      supportsContextCaching: true,
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /^gpt-5\.6-sol(?:-|$)/i,
    provider: 'azure',
  },
  {
    capabilities: {
      contextWindowTokens: 400_000,
      maxOutputTokens: 48_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /^gpt-5(?:\.|-|$)/i,
    provider: 'azure',
  },
  {
    capabilities: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 32_768,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /^gpt-4\.1(?:-|$)/i,
    provider: 'azure',
  },
  {
    capabilities: {
      ...FALLBACK_CAPABILITIES,
    },
    modelPattern: /.*/,
    provider: 'azure',
  },

  // OpenAI / Codex family (2026 constraints requested by user)
  {
    capabilities: {
      contextWindowTokens: 1_000_000,
      continuationStrategy: 'auto_continue',
      maxOutputTokens: 128_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep-sast',
      supportsContextCaching: true,
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /^gpt-5\.6-sol(?:-|$)/i,
    provider: 'openai',
  },
  {
    capabilities: {
      contextWindowTokens: 400_000,
      maxOutputTokens: 48_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'deep',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /gpt-5\.3-codex/i,
    provider: 'openai',
  },
  {
    capabilities: {
      contextWindowTokens: 400_000,
      maxOutputTokens: 40_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /gpt-5\.(2|1)(-codex)?/i,
    provider: 'openai',
  },
  {
    capabilities: {
      contextWindowTokens: 400_000,
      maxOutputTokens: 32_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: true,
      supportsReasoningMode: true,
    },
    modelPattern: /gpt-5(\.4)?-mini/i,
    provider: 'openai',
  },
  {
    capabilities: {
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
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
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: true,
    },
    modelPattern: /.*/,
    provider: 'deepseek',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
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
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'mistral',
  },
  {
    capabilities: {
      maxOutputTokens: 8000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'quick',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'moonshot',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'nvidia',
  },
  {
    capabilities: {
      maxOutputTokens: 8000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
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
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'perplexity',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      preferredAuditMode: 'balanced',
      supportsLongOutput: false,
      supportsReasoningMode: false,
    },
    modelPattern: /.*/,
    provider: 'qwen',
  },
  {
    capabilities: {
      maxOutputTokens: 16_000,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
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

export function effectiveContextWindowTokens(
  config: Pick<ShadowConfig, 'model' | 'provider'>,
): number {
  return resolveModelCapabilities(config).contextWindowTokens ?? FALLBACK_CAPABILITIES.contextWindowTokens!;
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

  return Math.min(requested, ABSOLUTE_MAX_TOOL_STEPS);
}

/**
 * Returns token and step budget multipliers for a given audit mode.
 *
 * - triage / quick: minimal retrieval, fastest scan
 * - balanced:       pragmatic depth
 * - deep / deep-sast: full analysis
 * - full-report:    deep-sast + report enrichment (slightly more tokens)
 * - patch-only:     only patches/fixes, no lengthy narrative
 */
export function auditModeBudgetMultiplier(mode: AuditMode): { steps: number; tokens: number } {
  switch (mode) {
    case 'balanced': {
      return { steps: 0.8, tokens: 0.7 };
    }

    case 'deep':
    case 'deep-sast': {
      return { steps: 1, tokens: 1 };
    }

    case 'full-report': {
      return { steps: 1, tokens: 1.2 };
    }

    case 'patch-only': {
      return { steps: 0.6, tokens: 0.5 };
    }

    case 'quick':
    case 'triage': {
      return { steps: 0.5, tokens: 0.4 };
    }

    default: {
      return { steps: 1, tokens: 1 };
    }
  }
}

export function resolveRuntimeSettings(
  config: Pick<ShadowConfig, 'maxOutputTokens' | 'maxToolSteps' | 'model' | 'provider'>,
  onWarning?: (message: string) => void,
  auditMode?: AuditMode,
): RuntimeSettings {
  const capabilities = resolveModelCapabilities(config);
  const baseTokens = effectiveMaxOutputTokens(config, onWarning);
  const baseSteps  = effectiveMaxToolSteps(config);

  if (!auditMode) {
    // No explicit mode: use raw model defaults (backward-compatible behaviour)
    return {
      capabilities,
      maxOutputTokens: baseTokens,
      maxToolSteps: baseSteps,
    };
  }

  const multiplier = auditModeBudgetMultiplier(auditMode);

  return {
    capabilities,
    maxOutputTokens: Math.min(
      capabilities.maxOutputTokens,
      Math.max(1, Math.round(baseTokens * multiplier.tokens)),
    ),
    maxToolSteps: Math.min(
      ABSOLUTE_MAX_TOOL_STEPS,
      Math.max(1, Math.round(baseSteps * multiplier.steps)),
    ),
  };
}

export interface BudgetManagerOptions {
    continuationStrategy?: ContinuationStrategy;
    criticalThreshold?: number;
    /** Cumulative output-token allowance for the complete run. */
    outputTokensBudget: number;
    runId: string;
    toolStepsBudget: number;
    warningThreshold?: number;
  }

  /**
   * Compatibility API for consumers that explicitly track cumulative run usage.
   * Runtime model construction uses `RuntimeSettings.maxOutputTokens` only as a
   * per-call provider ceiling and does not depend on this manager.
   */
  // eslint-disable-next-line unicorn/prefer-event-target
export class BudgetManager extends EventEmitter {
    private readonly continuationStrategy: ContinuationStrategy;
    private criticalEmitted = false;
    private readonly criticalThreshold: number;
    private lastUpdatedAt = new Date();
    private readonly outputTokensBudget: number;
    private outputTokensUsed = 0;
    private readonly runId: string;
    private readonly startedAt = new Date();
    private readonly toolStepsBudget: number;
    private toolStepsUsed = 0;
    private warningEmitted = false;
    private readonly warningThreshold: number;

    constructor(options: BudgetManagerOptions) {
      super();
      if (!Number.isSafeInteger(options.outputTokensBudget) || options.outputTokensBudget <= 0) {
        throw new RangeError('outputTokensBudget must be a positive safe integer.');
      }

      if (!Number.isSafeInteger(options.toolStepsBudget) || options.toolStepsBudget <= 0) {
        throw new RangeError('toolStepsBudget must be a positive safe integer.');
      }

      this.runId = options.runId;
      this.outputTokensBudget = options.outputTokensBudget;
      this.toolStepsBudget = options.toolStepsBudget;
      this.continuationStrategy = options.continuationStrategy ?? 'graceful_stop';
      this.warningThreshold = options.warningThreshold ?? 80;
      this.criticalThreshold = options.criticalThreshold ?? 95;
    }

    canAfford(estimatedTokens: number, estimatedSteps = 1): boolean {
      const status = this.getStatus();
      return status.outputTokensRemaining >= estimatedTokens && status.toolStepsRemaining >= estimatedSteps;
    }

    getContinuationStrategy(): ContinuationStrategy {
      return this.continuationStrategy;
    }

    getStatus(): BudgetStatus {
      const outputTokensRemaining = this.outputTokensBudget - this.outputTokensUsed;
      const toolStepsRemaining = this.toolStepsBudget - this.toolStepsUsed;
      const outputTokensPercent = Math.min(100, (this.outputTokensUsed / this.outputTokensBudget) * 100);
      const toolStepsPercent = Math.min(100, (this.toolStepsUsed / this.toolStepsBudget) * 100);
      const isExhausted = outputTokensRemaining <= 0 || toolStepsRemaining <= 0;

      return {
        continuationRequired: isExhausted ||
          outputTokensPercent >= this.criticalThreshold ||
          toolStepsPercent >= this.criticalThreshold,
        exhaustionReason: outputTokensRemaining <= 0 ?
          'Output token budget exhausted' :
          toolStepsRemaining <= 0 ? 'Tool step budget exhausted' : undefined,
        isExhausted,
        lastUpdatedAt: this.lastUpdatedAt.toISOString(),
        outputTokensBudget: this.outputTokensBudget,
        outputTokensPercent: Math.round(outputTokensPercent * 10) / 10,
        outputTokensRemaining,
        outputTokensUsed: this.outputTokensUsed,
        runId: this.runId,
        schemaVersion: SCHEMA_VERSION,
        startedAt: this.startedAt.toISOString(),
        toolStepsBudget: this.toolStepsBudget,
        toolStepsPercent: Math.round(toolStepsPercent * 10) / 10,
        toolStepsRemaining,
        toolStepsUsed: this.toolStepsUsed,
      };
    }

    getSummary(): string {
      const status = this.getStatus();
      return [
        `Budget: ${status.outputTokensUsed}/${status.outputTokensBudget} tokens (${status.outputTokensPercent.toFixed(1)}%)`,
        `${status.toolStepsUsed}/${status.toolStepsBudget} steps (${status.toolStepsPercent.toFixed(1)}%)`,
        status.continuationRequired ? `[CONTINUATION REQUIRED: ${this.continuationStrategy}]` : '',
      ].filter(Boolean).join(', ');
    }

    hasBudget(): boolean {
      return !this.getStatus().isExhausted;
    }

    needsContinuation(): boolean {
      return this.getStatus().continuationRequired;
    }

    recordStep(): void {
      this.toolStepsUsed++;
      this.lastUpdatedAt = new Date();
      this.checkThresholds();
    }

    recordTokens(count: number): void {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('Token usage must be a non-negative safe integer.');
      }

      this.outputTokensUsed += count;
      this.lastUpdatedAt = new Date();
      this.checkThresholds();
    }

    private checkThresholds(): void {
      const status = this.getStatus();
      const maxPercent = Math.max(status.outputTokensPercent, status.toolStepsPercent);
      if (!this.warningEmitted && maxPercent >= this.warningThreshold) {
        this.warningEmitted = true;
        this.emit('warning', status);
      }

      if (!this.criticalEmitted && maxPercent >= this.criticalThreshold) {
        this.criticalEmitted = true;
        this.emit('critical', status);
      }

      if (status.isExhausted) {
        this.emit('exhausted', status);
      }
    }
  }

  /**
   * Creates a cumulative compatibility budget. The token allowance is derived
   * from the per-call ceiling across the maximum model turns, never by treating
   * one call's provider limit as the entire mission budget.
   */
export function createBudgetManager(
    runId: string,
    settings: RuntimeSettings,
    continuationStrategy?: ContinuationStrategy,
  ): BudgetManager {
    return new BudgetManager({
      continuationStrategy: continuationStrategy ?? settings.capabilities.continuationStrategy ?? 'graceful_stop',
      outputTokensBudget: settings.maxOutputTokens * (settings.maxToolSteps + 1),
      runId,
      toolStepsBudget: settings.maxToolSteps,
    });
}
