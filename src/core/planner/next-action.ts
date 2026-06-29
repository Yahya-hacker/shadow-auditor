/**
 * Next Action - Action recommendation engine for attack chain verification.
 */

import * as crypto from 'node:crypto';

import type { KnowledgeGraph } from '../memory/knowledge-graph.js';
import type { AttackChainManager, AttackStepManager } from './attack-chain.js';
import type { AttackChain, AttackStep, PlannerAction, PlannerActionType } from './planner-schema.js';

export interface ActionRecommendation {
  action: PlannerAction;
  chain?: AttackChain;
  step?: AttackStep;
}

export interface NextActionOptions {
  focusChainId?: string;
  maxRecommendations?: number;
  preferVerification?: boolean;
}

/**
 * Recommends next actions for attack chain verification.
 */
export class NextActionPlanner {
  constructor(
    private readonly stepManager: AttackStepManager,
    private readonly chainManager: AttackChainManager,
    private readonly graph: KnowledgeGraph,
  ) {}

  /**
   * Get single best next action.
   */
  getBestAction(options: NextActionOptions = {}): ActionRecommendation | null {
    const recommendations = this.getRecommendations({ ...options, maxRecommendations: 1 });
    return recommendations[0] ?? null;
  }

  /**
   * Get actions for a specific chain.
   */
  getChainActions(chainId: string): ActionRecommendation[] {
    const chain = this.chainManager.getChain(chainId);
    if (!chain) {
      return [];
    }

    const recommendations: ActionRecommendation[] = [];

    // Get unverified steps
    const unverified = chain.steps
      .map((id) => this.stepManager.getStep(id))
      .filter((step): step is AttackStep => step !== undefined)
      .filter((step) => step.status !== 'verified' && step.status !== 'rejected');

    // For each unverified step, recommend verification or evidence collection
    for (const step of unverified) {
      if (this.canVerifyStep(step)) {
        recommendations.push({
          action: this.createVerifyStepAction(step),
          chain,
          step,
        });
      } else {
        recommendations.push({
          action: this.createCollectEvidenceAction(step),
          chain,
          step,
        });
      }
    }

    return recommendations;
  }

  /**
   * Get recommended next actions.
   */
  getRecommendations(options: NextActionOptions = {}): ActionRecommendation[] {
    const recommendations: ActionRecommendation[] = [];
    const maxRecs = options.maxRecommendations ?? 5;

    // Priority 1: Verify high-impact hypothesized steps
    if (options.preferVerification !== false) {
      const verifiableSteps = this.stepManager.getVerifiableSteps();
      for (const step of this.rankStepsByPriority(verifiableSteps)) {
        if (recommendations.length >= maxRecs) break;

        recommendations.push({
          action: this.createVerifyStepAction(step),
          step,
        });
      }
    }

    // Priority 2: Explore chains with partial verification
    const partialChains = this.chainManager.getAllChains().filter((c) => c.status === 'partial');
    for (const chain of this.rankChainsByPotential(partialChains)) {
      if (recommendations.length >= maxRecs) break;

      // Find unverified steps in chain
      const unverified = chain.steps
        .map((id) => this.stepManager.getStep(id))
        .filter((step): step is AttackStep => step !== undefined)
        .filter((step) => step.status !== 'verified' && step.status !== 'rejected');

      if (unverified.length > 0) {
        recommendations.push({
          action: this.createCollectEvidenceAction(unverified[0]),
          chain,
          step: unverified[0],
        });
      }
    }

    // Priority 3: Find new sources/sinks for exploration
    if (recommendations.length < maxRecs) {
      const sources = this.graph.getEntitiesByType('source');
      const sinks = this.graph.getEntitiesByType('sink');

      if (sources.length === 0) {
        recommendations.push({
          action: this.createFindSourcesAction(),
        });
      }

      if (sinks.length === 0 && recommendations.length < maxRecs) {
        recommendations.push({
          action: this.createFindSinksAction(),
        });
      }
    }

    // Priority 4: Trace data flows for hypothesized chains
    if (recommendations.length < maxRecs) {
      const hypothesizedChains = this.chainManager.getHypothesizedChains();
      for (const chain of hypothesizedChains) {
        if (recommendations.length >= maxRecs) break;

        recommendations.push({
          action: this.createTraceFlowAction(chain),
          chain,
        });
      }
    }

    return recommendations.slice(0, maxRecs);
  }

  /**
   * Check if a step can be verified.
   */
  private canVerifyStep(step: AttackStep): boolean {
    // Check prerequisites are met
    const verified = new Set(
      this.stepManager
        .getAllSteps()
        .filter((s) => s.status === 'verified')
        .map((s) => s.stepId),
    );

    return step.prerequisites.every((prereq) => verified.has(prereq));
  }

  /**
   * Create a collect evidence action.
   */
  private createCollectEvidenceAction(step: AttackStep): PlannerAction {
    return {
      actionId: this.generateActionId(),
      actionType: 'collect_evidence',
      estimatedValue: 0.6,
      parameters: {
        currentConfidence: step.confidence,
        entityIds: step.entityIds,
        stepId: step.stepId,
      },
      priority: 50,
      rationale: `Collect evidence for ${step.title} (current confidence: ${step.confidence.toFixed(2)})`,
      targetStepId: step.stepId,
    };
  }

  /**
   * Create a find sinks action.
   */
  private createFindSinksAction(): PlannerAction {
    return {
      actionId: this.generateActionId(),
      actionType: 'find_sinks',
      estimatedValue: 0.8,
      parameters: {},
      priority: 70,
      rationale: 'No data sinks discovered yet. Find potentially dangerous sinks.',
    };
  }

  /**
   * Create a find sources action.
   */
  private createFindSourcesAction(): PlannerAction {
    return {
      actionId: this.generateActionId(),
      actionType: 'find_sources',
      estimatedValue: 0.8,
      parameters: {},
      priority: 70,
      rationale: 'No data sources discovered yet. Find user input sources.',
    };
  }

  /**
   * Create a trace flow action.
   */
  private createTraceFlowAction(chain: AttackChain): PlannerAction {
    return {
      actionId: this.generateActionId(),
      actionType: 'trace_flow',
      estimatedValue: chain.feasibility,
      parameters: {
        chainId: chain.chainId,
        stepIds: chain.steps,
      },
      priority: Math.round(chain.score * 0.8),
      rationale: `Trace data flow for ${chain.title}`,
    };
  }

  /**
   * Create a verify step action.
   */
  private createVerifyStepAction(step: AttackStep): PlannerAction {
    return {
      actionId: this.generateActionId(),
      actionType: 'verify_step',
      estimatedValue: step.impact * step.feasibility,
      parameters: {
        cwe: step.cwe,
        entityIds: step.entityIds,
        stepId: step.stepId,
      },
      priority: Math.round(step.impact * 100),
      rationale: `Verify ${step.title} (impact: ${step.impact.toFixed(2)}, feasibility: ${step.feasibility.toFixed(2)})`,
      targetStepId: step.stepId,
    };
  }

  /**
   * Generate unique action ID.
   */
  private generateActionId(): string {
    return `action_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Rank chains by exploitation potential.
   */
  private rankChainsByPotential(chains: AttackChain[]): AttackChain[] {
    return [...chains].sort((a, b) => b.score - a.score);
  }

  /**
   * Rank steps by verification priority.
   */
  private rankStepsByPriority(steps: AttackStep[]): AttackStep[] {
    return [...steps].sort((a, b) => {
      // Higher impact first
      if (b.impact !== a.impact) {
        return b.impact - a.impact;
      }

      // Higher feasibility second
      if (b.feasibility !== a.feasibility) {
        return b.feasibility - a.feasibility;
      }

      // More evidence third
      return b.evidenceIds.length - a.evidenceIds.length;
    });
  }
}
