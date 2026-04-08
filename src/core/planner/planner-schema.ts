/**
 * Planner Schemas - Typed contracts for attack chain planning.
 */

import { z } from 'zod';

import { canonicalIdSchema, confidenceSchema, shortIdSchema, timestampSchema } from '../schema/base.js';

// ============================================================================
// Attack Step Schema
// ============================================================================

export const attackStepStatusSchema = z.enum([
  'hypothesized',   // Proposed but not verified
  'investigating',  // Currently being investigated
  'verified',       // Confirmed with evidence
  'rejected',       // Disproven or not exploitable
  'blocked',        // Cannot proceed due to dependency
]);
export type AttackStepStatus = z.infer<typeof attackStepStatusSchema>;

export const attackCategorySchema = z.enum([
  'injection',
  'broken_auth',
  'sensitive_data',
  'xxe',
  'access_control',
  'security_misconfig',
  'xss',
  'deserialization',
  'components',
  'logging',
  'ssrf',
  'other',
]);
export type AttackCategory = z.infer<typeof attackCategorySchema>;

/**
 * A single step in an attack chain.
 */
export const attackStepSchema = z.object({
  attackCategory: attackCategorySchema,
  confidence: confidenceSchema,
  createdAt: timestampSchema,
  cwe: z.string().regex(/^CWE-\d+$/),
  description: z.string().min(1),
  entityIds: z.array(canonicalIdSchema).default([]),
  evidenceIds: z.array(shortIdSchema).default([]),
  feasibility: confidenceSchema,
  impact: confidenceSchema,
  prerequisites: z.array(shortIdSchema).default([]),
  status: attackStepStatusSchema,
  stepId: shortIdSchema,
  title: z.string().min(1),
  updatedAt: timestampSchema,
});
export type AttackStep = z.infer<typeof attackStepSchema>;

// ============================================================================
// Attack Chain Schema
// ============================================================================

export const chainStatusSchema = z.enum([
  'hypothesized',
  'investigating',
  'verified',
  'rejected',
  'partial',  // Some steps verified, others not
]);
export type ChainStatus = z.infer<typeof chainStatusSchema>;

/**
 * An ordered sequence of attack steps forming an attack chain.
 */
export const attackChainSchema = z.object({
  chainId: shortIdSchema,
  createdAt: timestampSchema,
  description: z.string().min(1),
  evidenceDensity: confidenceSchema,  // Ratio of evidence-backed steps
  feasibility: confidenceSchema,       // Overall feasibility score
  impact: confidenceSchema,            // Overall impact score
  score: z.number().min(0).max(100),   // Composite ranking score
  status: chainStatusSchema,
  steps: z.array(shortIdSchema).min(1),
  title: z.string().min(1),
  updatedAt: timestampSchema,
});
export type AttackChain = z.infer<typeof attackChainSchema>;

// ============================================================================
// Planner Action Schema
// ============================================================================

export const plannerActionTypeSchema = z.enum([
  'verify_step',      // Verify an attack step
  'explore_path',     // Explore a potential path
  'collect_evidence', // Gather more evidence for a step
  'test_exploit',     // Test exploitability
  'find_sources',     // Find data sources
  'find_sinks',       // Find data sinks
  'trace_flow',       // Trace data flow
  'analyze_code',     // Analyze code for vulnerabilities
]);
export type PlannerActionType = z.infer<typeof plannerActionTypeSchema>;

/**
 * A planned action recommended by the planner.
 */
export const plannerActionSchema = z.object({
  actionId: shortIdSchema,
  actionType: plannerActionTypeSchema,
  estimatedValue: z.number().min(0).max(1),  // Expected information gain
  parameters: z.record(z.unknown()),
  priority: z.number().int(),
  rationale: z.string().min(1),
  targetStepId: shortIdSchema.optional(),
});
export type PlannerAction = z.infer<typeof plannerActionSchema>;

// ============================================================================
// Planner State Schema
// ============================================================================

export const plannerStateSchema = z.object({
  chains: z.array(attackChainSchema).default([]),
  currentFocus: shortIdSchema.optional(),
  lastUpdatedAt: timestampSchema,
  pendingActions: z.array(plannerActionSchema).default([]),
  runId: shortIdSchema,
  steps: z.array(attackStepSchema).default([]),
});
export type PlannerState = z.infer<typeof plannerStateSchema>;

// ============================================================================
// Chain Ranking Criteria
// ============================================================================

export interface ChainRankingWeights {
  evidenceDensity: number;
  feasibility: number;
  impact: number;
}

export const DEFAULT_RANKING_WEIGHTS: ChainRankingWeights = {
  evidenceDensity: 0.3,
  feasibility: 0.3,
  impact: 0.4,
};

/**
 * Calculate chain ranking score.
 */
export function calculateChainScore(
  chain: Pick<AttackChain, 'evidenceDensity' | 'feasibility' | 'impact'>,
  weights: ChainRankingWeights = DEFAULT_RANKING_WEIGHTS,
): number {
  const normalized =
    chain.impact * weights.impact +
    chain.feasibility * weights.feasibility +
    chain.evidenceDensity * weights.evidenceDensity;

  return Math.round(normalized * 100);
}
