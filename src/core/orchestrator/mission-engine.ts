/**
 * Mission Engine - Core orchestration logic for OODA loop execution.
 */

import * as crypto from 'node:crypto';

import { EventStore } from '../memory/event-store.js';
import { KnowledgeGraph } from '../memory/knowledge-graph.js';
import { Retrieval } from '../memory/retrieval.js';
import { err, ok, type Result } from '../schema/base.js';
import { CheckpointManager, computeStateHash } from './checkpoints.js';
import {
  type BudgetState,
  type Hypothesis,
  isTerminalPhase,
  type MissionObjective,
  type MissionPhase,
  type MissionState,
  missionStateSchema,
  type PendingAction,
  PHASE_DESCRIPTIONS,
  phaseAllowsToolExecution,
} from './mission-state.js';
import {
  attemptTransition,
  calculateMissionConfidence,
  getAllowedTransitionsForState,
  isBudgetExhausted,
  recommendNextPhase,
  type TransitionContext,
  type TransitionResult,
} from './transitions.js';

export interface MissionEngineOptions {
  maxTokens?: number;
  maxToolCalls?: number;
  runId: string;
  storagePath: string;
}

export interface PhaseHandler {
  execute: (engine: MissionEngine, state: MissionState) => Promise<PhaseResult>;
  phase: MissionPhase;
}

export interface PhaseResult {
  context: TransitionContext;
  nextPhase: MissionPhase;
  reason: import('./mission-state.js').TransitionReason;
}

/**
 * Core mission orchestration engine.
 */
export class MissionEngine {
  private checkpointManager: CheckpointManager;
  private eventStore!: EventStore;
  private graph!: KnowledgeGraph;
  private initialized = false;
  private readonly options: Required<MissionEngineOptions>;
  private phaseHandlers: Map<MissionPhase, PhaseHandler> = new Map();
  private retrieval!: Retrieval;
private state!: MissionState;

  constructor(options: MissionEngineOptions) {
    this.options = {
      maxTokens: options.maxTokens ?? 100_000,
      maxToolCalls: options.maxToolCalls ?? 50,
      runId: options.runId,
      storagePath: options.storagePath,
    };

    this.checkpointManager = new CheckpointManager({
      runId: this.options.runId,
      storagePath: this.options.storagePath,
    });
  }

  /**
   * Add a hypothesis to the mission.
   */
  addHypothesis(hypothesis: Omit<Hypothesis, 'createdAt' | 'hypothesisId' | 'updatedAt'>): Hypothesis {
    this.ensureInitialized();

    const now = new Date().toISOString();
    const fullHypothesis: Hypothesis = {
      ...hypothesis,
      createdAt: now,
      hypothesisId: `hyp_${crypto.randomBytes(8).toString('hex')}`,
      updatedAt: now,
    };

    this.state = {
      ...this.state,
      hypotheses: [...this.state.hypotheses, fullHypothesis],
    };

    return fullHypothesis;
  }

  /**
   * Check if tool execution is allowed in current phase.
   */
  canExecuteTool(): boolean {
    this.ensureInitialized();
    return phaseAllowsToolExecution(this.state.currentPhase) && !isBudgetExhausted(this.state.budget);
  }

  /**
   * Mark action as completed.
   */
  completeAction(actionId: string, tokensUsed?: number): void {
    this.ensureInitialized();

    this.state = {
      ...this.state,
      budget: {
        ...this.state.budget,
        tokensUsed: this.state.budget.tokensUsed + (tokensUsed ?? 0),
        toolCallsUsed: this.state.budget.toolCallsUsed + 1,
      },
      completedActions: [...this.state.completedActions, actionId],
      pendingActions: this.state.pendingActions.filter((a) => a.actionId !== actionId),
    };
  }

  /**
   * Get the event store.
   */
  getEventStore(): EventStore {
    this.ensureInitialized();
    return this.eventStore;
  }

  /**
   * Get the knowledge graph.
   */
  getGraph(): KnowledgeGraph {
    this.ensureInitialized();
    return this.graph;
  }

  /**
   * Get next action to execute.
   */
  getNextAction(): null | PendingAction {
    this.ensureInitialized();

    if (this.state.pendingActions.length === 0) {
      return null;
    }

    // Sort by priority descending
    const sorted = [...this.state.pendingActions].sort((a, b) => b.priority - a.priority);
    return sorted[0];
  }

  /**
   * Get remaining budget.
   */
  getRemainingBudget(): { tokens: number; toolCalls: number } {
    this.ensureInitialized();
    return {
      tokens: this.state.budget.maxTokens - this.state.budget.tokensUsed,
      toolCalls: this.state.budget.maxToolCalls - this.state.budget.toolCallsUsed,
    };
  }

  /**
   * Get the retrieval service.
   */
  getRetrieval(): Retrieval {
    this.ensureInitialized();
    return this.retrieval;
  }

  /**
   * Get current mission state.
   */
  getState(): MissionState {
    this.ensureInitialized();
    return { ...this.state };
  }

  /**
   * Initialize the engine, optionally resuming from checkpoint.
   */
  async initialize(objectives?: MissionObjective[]): Promise<void> {
    await this.checkpointManager.initialize();

    // Initialize subsystems
    this.eventStore = await EventStore.create({
      runId: this.options.runId,
      storagePath: this.options.storagePath,
    });

    this.graph = await KnowledgeGraph.create({
      runId: this.options.runId,
      storagePath: this.options.storagePath,
    });

    this.retrieval = new Retrieval(this.graph);

    // Try to resume from checkpoint
    const latestCheckpoint = await this.checkpointManager.loadLatestCheckpoint();
    if (latestCheckpoint.ok && latestCheckpoint.value) {
      this.state = latestCheckpoint.value;
      await this.recordEvent('checkpoint_restored', {
        checkpointPhase: this.state.currentPhase,
        missionId: this.state.missionId,
      });
    } else {
      // Create new mission state
      this.state = this.createInitialState(objectives ?? []);
      await this.recordEvent('mission_started', {
        missionId: this.state.missionId,
        objectives: this.state.objectives.length,
      });
    }

    this.initialized = true;
  }

  /**
   * Queue an action for execution.
   */
  queueAction(action: Omit<PendingAction, 'actionId'>): PendingAction {
    this.ensureInitialized();

    const fullAction: PendingAction = {
      ...action,
      actionId: `act_${crypto.randomBytes(8).toString('hex')}`,
    };

    this.state = {
      ...this.state,
      pendingActions: [...this.state.pendingActions, fullAction],
    };

    return fullAction;
  }

  /**
   * Register a phase handler.
   */
  registerPhaseHandler(handler: PhaseHandler): void {
    this.phaseHandlers.set(handler.phase, handler);
  }

  /**
   * Run the full OODA loop until completion or budget exhaustion.
   */
  async run(): Promise<Result<MissionState, string>> {
    this.ensureInitialized();

    while (!isTerminalPhase(this.state.currentPhase)) {
      const stepResult = await this.step();
      if (!stepResult.ok) {
        return err(stepResult.error);
      }

      // Checkpoint after each significant transition
      if (this.shouldCheckpoint()) {
        await this.saveCheckpoint();
      }

      // Check budget
      if (isBudgetExhausted(this.state.budget) && this.state.currentPhase !== 'REPORT' && this.state.currentPhase !== 'COMPLETE') {
          // Force transition to REPORT if we have findings, else FAILED
          const nextPhase = this.state.hypotheses.some((h) => h.status === 'verified') ? 'REPORT' : 'FAILED';
          await this.transition(nextPhase, 'budget_exhausted', {});
        }
    }

    // Final checkpoint
    await this.saveCheckpoint();
    await this.graph.saveSnapshot();

    return ok(this.state);
  }

  /**
   * Save a checkpoint.
   */
  async saveCheckpoint(): Promise<void> {
    await this.checkpointManager.saveCheckpoint(this.state);
  }

  /**
   * Execute one OODA loop iteration.
   */
  async step(): Promise<Result<{ completed: boolean; phase: MissionPhase }, string>> {
    this.ensureInitialized();

    if (isTerminalPhase(this.state.currentPhase)) {
      return ok({ completed: true, phase: this.state.currentPhase });
    }

    // Get handler for current phase
    const handler = this.phaseHandlers.get(this.state.currentPhase);
    if (!handler) {
      // Use default transition recommendation
      const recommendation = recommendNextPhase(this.state);
      if (!recommendation) {
        return err(`No handler or recommendation for phase: ${this.state.currentPhase}`);
      }

      const transitionResult = await this.transition(recommendation.phase, recommendation.reason, {});
      if (!transitionResult.ok) {
        return err(transitionResult.error);
      }

      return ok({ completed: isTerminalPhase(this.state.currentPhase), phase: this.state.currentPhase });
    }

    // Execute phase handler
    try {
      const result = await handler.execute(this, this.state);
      const transitionResult = await this.transition(result.nextPhase, result.reason, result.context);

      if (!transitionResult.ok) {
        return err(transitionResult.error);
      }

      return ok({ completed: isTerminalPhase(this.state.currentPhase), phase: this.state.currentPhase });
    } catch (error) {
      // Transition to FAILED on unhandled errors
      await this.transition('FAILED', 'error_occurred', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(`Phase execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Manually transition to a new phase.
   */
  async transition(
    targetPhase: MissionPhase,
    reason: import('./mission-state.js').TransitionReason,
    context: TransitionContext,
  ): Promise<Result<void, string>> {
    const result = attemptTransition(this.state, targetPhase, reason, context);
    if (!result.ok) {
      return err(result.error);
    }

    this.state = result.value.newState;

    // Update confidence
    this.state = {
      ...this.state,
      confidence: calculateMissionConfidence(this.state),
    };

    // Record events
    for (const event of result.value.events) {
      await this.recordEvent(event.type as import('../memory/memory-schema.js').EventType, event.payload);
    }

    return ok();
  }

  /**
   * Update hypothesis status.
   */
  updateHypothesis(
    hypothesisId: string,
    updates: Partial<Pick<Hypothesis, 'confidence' | 'evidenceIds' | 'status'>>,
  ): Result<Hypothesis, string> {
    this.ensureInitialized();

    const index = this.state.hypotheses.findIndex((h) => h.hypothesisId === hypothesisId);
    if (index === -1) {
      return err(`Hypothesis not found: ${hypothesisId}`);
    }

    const updated: Hypothesis = {
      ...this.state.hypotheses[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    const newHypotheses = [...this.state.hypotheses];
    newHypotheses[index] = updated;

    this.state = {
      ...this.state,
      hypotheses: newHypotheses,
    };

    return ok(updated);
  }

  private createInitialState(objectives: MissionObjective[]): MissionState {
    const now = new Date().toISOString();
    return {
      budget: {
        maxTokens: this.options.maxTokens,
        maxToolCalls: this.options.maxToolCalls,
        tokensUsed: 0,
        toolCallsUsed: 0,
      },
      completedActions: [],
      confidence: 0,
      currentPhase: 'OBSERVE',
      hypotheses: [],
      lastTransitionAt: now,
      missionId: `mission_${this.options.runId}`,
      objectives,
      pendingActions: [],
      phaseHistory: [
        {
          phase: 'OBSERVE',
          reason: 'evidence_collected',
          timestamp: now,
        },
      ],
      startedAt: now,
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MissionEngine not initialized. Call initialize() first.');
    }
  }

  private async recordEvent(eventType: import('../memory/memory-schema.js').EventType, payload: Record<string, unknown>): Promise<void> {
    await this.eventStore.append(eventType, {
      ...payload,
      missionPhase: this.state.currentPhase,
    });
  }

  private shouldCheckpoint(): boolean {
    // Checkpoint on significant phases
    const significantPhases: MissionPhase[] = ['VERIFY', 'REPORT', 'COMPLETE', 'FAILED'];
    return significantPhases.includes(this.state.currentPhase);
  }
}
