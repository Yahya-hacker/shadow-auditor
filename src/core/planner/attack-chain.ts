/**
 * Attack Chain - Core attack chain data structure and operations.
 */

import * as crypto from 'node:crypto';

import type { KnowledgeGraph } from '../memory/knowledge-graph.js';
import type { BaseEntity } from '../memory/memory-schema.js';

import { err, ok, type Result } from '../schema/base.js';
import {
  type AttackCategory,
  type AttackChain,
  attackChainSchema,
  type AttackStep,
  attackStepSchema,
  type AttackStepStatus,
  calculateChainScore,
  type ChainRankingWeights,
  type ChainStatus,
  DEFAULT_RANKING_WEIGHTS,
} from './planner-schema.js';

export interface AttackStepInput {
  attackCategory: AttackCategory;
  cwe: string;
  description: string;
  entityIds?: string[];
  feasibility?: number;
  impact?: number;
  prerequisites?: string[];
  title: string;
}

/**
 * Manages attack steps and their relationships.
 */
export class AttackStepManager {
  private steps: Map<string, AttackStep> = new Map();

  /**
   * Create a new attack step.
   */
  createStep(input: AttackStepInput): Result<AttackStep, string> {
    const now = new Date().toISOString();
    const stepId = `step_${crypto.randomBytes(8).toString('hex')}`;

    const step: AttackStep = {
      attackCategory: input.attackCategory,
      confidence: 0.1, // Low initial confidence
      createdAt: now,
      cwe: input.cwe,
      description: input.description,
      entityIds: input.entityIds ?? [],
      evidenceIds: [],
      feasibility: input.feasibility ?? 0.5,
      impact: input.impact ?? 0.5,
      prerequisites: input.prerequisites ?? [],
      status: 'hypothesized',
      stepId,
      title: input.title,
      updatedAt: now,
    };

    const validation = attackStepSchema.safeParse(step);
    if (!validation.success) {
      return err(`Invalid step: ${validation.error.message}`);
    }

    this.steps.set(stepId, step);
    return ok(step);
  }

  /**
   * Export steps for persistence.
   */
  exportSteps(): AttackStep[] {
    return this.getAllSteps();
  }

  /**
   * Get all steps.
   */
  getAllSteps(): AttackStep[] {
    return [...this.steps.values()];
  }

  /**
   * Get a step by ID.
   */
  getStep(stepId: string): AttackStep | undefined {
    return this.steps.get(stepId);
  }

  /**
   * Get steps by status.
   */
  getStepsByStatus(status: AttackStepStatus): AttackStep[] {
    return this.getAllSteps().filter((s) => s.status === status);
  }

  /**
   * Get steps that can be verified (no unverified prerequisites).
   */
  getVerifiableSteps(): AttackStep[] {
    const verified = new Set(
      this.getAllSteps()
        .filter((s) => s.status === 'verified')
        .map((s) => s.stepId),
    );

    return this.getAllSteps().filter((step) => {
      if (step.status !== 'hypothesized' && step.status !== 'investigating') {
        return false;
      }

      // All prerequisites must be verified
      return step.prerequisites.every((prereq) => verified.has(prereq));
    });
  }

  /**
   * Check if a step has cyclic dependencies.
   */
  hasCyclicDependency(stepId: string, visited = new Set<string>()): boolean {
    if (visited.has(stepId)) {
      return true;
    }

    const step = this.steps.get(stepId);
    if (!step) {
      return false;
    }

    visited.add(stepId);
    for (const prereq of step.prerequisites) {
      if (this.hasCyclicDependency(prereq, visited)) {
        return true;
      }
    }

    visited.delete(stepId);

    return false;
  }

  /**
   * Import steps from persistence.
   */
  importSteps(steps: AttackStep[]): void {
    this.steps.clear();
    for (const step of steps) {
      this.steps.set(step.stepId, step);
    }
  }

  /**
   * Link entity to step.
   */
  linkEntity(stepId: string, entityId: string): Result<AttackStep, string> {
    const step = this.steps.get(stepId);
    if (!step) {
      return err(`Step not found: ${stepId}`);
    }

    if (step.entityIds.includes(entityId)) {
      return ok(step); // Already linked
    }

    const updated: AttackStep = {
      ...step,
      entityIds: [...step.entityIds, entityId],
      updatedAt: new Date().toISOString(),
    };

    this.steps.set(stepId, updated);
    return ok(updated);
  }

  /**
   * Update step confidence based on new evidence.
   */
  updateStepConfidence(stepId: string, confidence: number, evidenceId?: string): Result<AttackStep, string> {
    const step = this.steps.get(stepId);
    if (!step) {
      return err(`Step not found: ${stepId}`);
    }

    const updated: AttackStep = {
      ...step,
      confidence: Math.min(1, Math.max(0, confidence)),
      evidenceIds: evidenceId ? [...step.evidenceIds, evidenceId] : step.evidenceIds,
      updatedAt: new Date().toISOString(),
    };

    this.steps.set(stepId, updated);
    return ok(updated);
  }

  /**
   * Update step status.
   */
  updateStepStatus(stepId: string, status: AttackStepStatus): Result<AttackStep, string> {
    const step = this.steps.get(stepId);
    if (!step) {
      return err(`Step not found: ${stepId}`);
    }

    const updated: AttackStep = {
      ...step,
      status,
      updatedAt: new Date().toISOString(),
    };

    this.steps.set(stepId, updated);
    return ok(updated);
  }
}

/**
 * Manages attack chains built from steps.
 */
export class AttackChainManager {
  private chains: Map<string, AttackChain> = new Map();
  private readonly stepManager: AttackStepManager;

  constructor(stepManager: AttackStepManager) {
    this.stepManager = stepManager;
  }

  /**
   * Create a new attack chain from steps.
   */
  createChain(
    title: string,
    description: string,
    stepIds: string[],
  ): Result<AttackChain, string> {
    // Validate all steps exist
    for (const stepId of stepIds) {
      if (!this.stepManager.getStep(stepId)) {
        return err(`Step not found: ${stepId}`);
      }
    }

    const now = new Date().toISOString();
    const chainId = `chain_${crypto.randomBytes(8).toString('hex')}`;

    // Calculate initial metrics
    const metrics = this.calculateChainMetrics(stepIds);

    const chain: AttackChain = {
      chainId,
      createdAt: now,
      description,
      evidenceDensity: metrics.evidenceDensity,
      feasibility: metrics.feasibility,
      impact: metrics.impact,
      score: calculateChainScore(metrics),
      status: this.determineChainStatus(stepIds),
      steps: stepIds,
      title,
      updatedAt: now,
    };

    const validation = attackChainSchema.safeParse(chain);
    if (!validation.success) {
      return err(`Invalid chain: ${validation.error.message}`);
    }

    this.chains.set(chainId, chain);
    return ok(chain);
  }

  /**
   * Export chains for persistence.
   */
  exportChains(): AttackChain[] {
    return this.getAllChains();
  }

  /**
   * Get all chains.
   */
  getAllChains(): AttackChain[] {
    return [...this.chains.values()];
  }

  /**
   * Get a chain by ID.
   */
  getChain(chainId: string): AttackChain | undefined {
    return this.chains.get(chainId);
  }

  /**
   * Get hypothesized (unverified) chains.
   */
  getHypothesizedChains(): AttackChain[] {
    return this.getAllChains().filter((c) => c.status === 'hypothesized' || c.status === 'partial');
  }

  /**
   * Get chains ranked by score.
   */
  getRankedChains(weights?: ChainRankingWeights): AttackChain[] {
    const effectiveWeights = weights ?? DEFAULT_RANKING_WEIGHTS;

    // Recalculate scores with current weights
    const scored = this.getAllChains().map((chain) => ({
      chain,
      score: calculateChainScore(chain, effectiveWeights),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.chain);
  }

  /**
   * Get verified chains.
   */
  getVerifiedChains(): AttackChain[] {
    return this.getAllChains().filter((c) => c.status === 'verified');
  }

  /**
   * Import chains from persistence.
   */
  importChains(chains: AttackChain[]): void {
    this.chains.clear();
    for (const chain of chains) {
      this.chains.set(chain.chainId, chain);
    }
  }

  /**
   * Update chain after step changes.
   */
  refreshChain(chainId: string): Result<AttackChain, string> {
    const chain = this.chains.get(chainId);
    if (!chain) {
      return err(`Chain not found: ${chainId}`);
    }

    const metrics = this.calculateChainMetrics(chain.steps);
    const updated: AttackChain = {
      ...chain,
      evidenceDensity: metrics.evidenceDensity,
      feasibility: metrics.feasibility,
      impact: metrics.impact,
      score: calculateChainScore(metrics),
      status: this.determineChainStatus(chain.steps),
      updatedAt: new Date().toISOString(),
    };

    this.chains.set(chainId, updated);
    return ok(updated);
  }

  /**
   * Calculate chain metrics from steps.
   */
  private calculateChainMetrics(stepIds: string[]): {
    evidenceDensity: number;
    feasibility: number;
    impact: number;
  } {
    const steps = stepIds
      .map((id) => this.stepManager.getStep(id))
      .filter((step): step is AttackStep => step !== undefined);

    if (steps.length === 0) {
      return { evidenceDensity: 0, feasibility: 0, impact: 0 };
    }

    // Impact: max of all steps
    const impact = Math.max(...steps.map((s) => s.impact));

    // Feasibility: product of step feasibilities (chain is only as feasible as weakest link)
    const feasibility = steps.reduce((acc, s) => acc * s.feasibility, 1);

    // Evidence density: ratio of evidence-backed steps
    const evidenceBacked = steps.filter((s) => s.evidenceIds.length > 0 || s.confidence >= 0.7).length;
    const evidenceDensity = evidenceBacked / steps.length;

    return { evidenceDensity, feasibility, impact };
  }

  /**
   * Determine chain status from steps.
   */
  private determineChainStatus(stepIds: string[]): ChainStatus {
    const steps = stepIds
      .map((id) => this.stepManager.getStep(id))
      .filter((step): step is AttackStep => step !== undefined);

    if (steps.length === 0) {
      return 'hypothesized';
    }

    const verified = steps.filter((s) => s.status === 'verified').length;
    const rejected = steps.filter((s) => s.status === 'rejected').length;

    if (rejected > 0) {
      return 'rejected';
    }

    if (verified === steps.length) {
      return 'verified';
    }

    if (verified > 0) {
      return 'partial';
    }

    if (steps.some((s) => s.status === 'investigating')) {
      return 'investigating';
    }

    return 'hypothesized';
  }
}
