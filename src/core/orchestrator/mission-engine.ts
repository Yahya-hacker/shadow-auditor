/**
 * Mission Engine - Core orchestration logic for OODA loop execution.
 */

import * as crypto from 'node:crypto';

import type { NormalizedTokenUsage } from '../usage.js';
import type {
  MissionModelInvocation,
  MissionRuntimeObserver,
  MissionToolCall,
  MissionToolResult,
} from './mission-runtime.js';

import { EventStore } from '../memory/event-store.js';
import { KnowledgeGraph } from '../memory/knowledge-graph.js';
import { Retrieval } from '../memory/retrieval.js';
import { err, ok, type Result } from '../schema/base.js';
import { CheckpointManager } from './checkpoints.js';
import {
  type Hypothesis,
  isTerminalPhase,
  type MissionObjective,
  type MissionPhase,
  type MissionState,
  type PendingAction,
  phaseAllowsToolExecution,
} from './mission-state.js';
import {
  attemptTransition,
  calculateMissionConfidence,
  isBudgetExhausted,
  recommendNextPhase,
  type TransitionContext,
} from './transitions.js';

export interface MissionEngineOptions {
  maxTokens?: number;
  maxTokensPerInvocation?: number;
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
export class MissionEngine implements MissionRuntimeObserver {
  private checkpointManager: CheckpointManager;
  private readonly completedStages = new Set<string>();
  private eventStore!: EventStore;
  private graph!: KnowledgeGraph;
  private initialized = false;
  private readonly options: Required<MissionEngineOptions>;
  private phaseHandlers: Map<MissionPhase, PhaseHandler> = new Map();
  private retrieval!: Retrieval;
  private runtimeMutation: Promise<void> = Promise.resolve();
  private readonly startedStages = new Set<string>();
  private state!: MissionState;

  constructor(options: MissionEngineOptions) {
    this.options = {
      maxTokens: options.maxTokens ?? 100_000,
      maxTokensPerInvocation: options.maxTokensPerInvocation ?? 32_000,
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

  async afterModelInvocation(
    invocation: MissionModelInvocation,
    usage: NormalizedTokenUsage | undefined,
    reservationId?: string,
  ): Promise<void> {
    await this.mutateRuntime(async () => {
      if (!reservationId) {
        throw new Error(`Missing mission reservation for ${invocation.stage} model usage.`);
      }

      const reserved = this.state.budget.modelReservations[reservationId];
      if (!reserved) {
        throw new Error(`Unknown or already reconciled model reservation "${reservationId}".`);
      }

      const modelReservations = {...this.state.budget.modelReservations};
      delete modelReservations[reservationId];
      const chargedTokens = usage
        ? Math.max(usage.total, invocation.estimatedTokens ?? 0)
        : reserved;
      this.state = {
        ...this.state,
        budget: {
          ...this.state.budget,
          modelReservations,
          tokensUsed: this.state.budget.tokensUsed + chargedTokens,
        },
      };
      await this.recordEvent('model_usage', {
        ...invocation,
        chargedTokens,
        reservationId,
        usage: usage ?? null,
      });
      await this.saveCheckpoint();
    });
  }

  async afterToolExecution(
    invocation: MissionModelInvocation,
    results: MissionToolResult[],
  ): Promise<void> {
    await this.mutateRuntime(async () => {
      for (const result of results) {
        await this.recordEvent('tool_result', {
          ...invocation,
          ...result,
        });
      }

      // Release reservations for calls that reached a terminal state so the
      // in-memory and persisted budget do not accumulate unbounded keys over a
      // long mission (#5). `beforeToolExecution` re-reserves on replay and the
      // restorer's `reconcileToolReservations` drops keys with no durable
      // `tool_call` event, so a successful result is safe to free here.
      const released = results
        .map(({callId}) =>
          `${invocation.agentId ?? invocation.stage}:` +
          `${invocation.executionId ?? 'unscoped'}:${callId}`)
        .filter((key) => this.state.budget.reservedToolCallIds.includes(key));
      if (released.length === 0) return;

      this.state = {
        ...this.state,
        budget: {
          ...this.state.budget,
          reservedToolCallIds: this.state.budget.reservedToolCallIds
            .filter((key) => !released.includes(key)),
        },
      };
      await this.saveCheckpoint();
    });
  }

  async beforeModelInvocation(invocation: MissionModelInvocation): Promise<string> {
    let reservationId = '';
    await this.mutateRuntime(async () => {
      reservationId = crypto.randomUUID();
      const reservedTokens = Object.values(this.state.budget.modelReservations)
        .reduce((total, value) => total + value, 0);
      const available = this.state.budget.maxTokens - this.state.budget.tokensUsed - reservedTokens;
      if (available < this.options.maxTokensPerInvocation) {
        throw new Error(
          `Mission token budget exhausted before ${invocation.stage} could reserve ` +
          `${this.options.maxTokensPerInvocation} tokens (${Math.max(0, available)} available).`,
        );
      }

      const previousState = this.state;
      this.state = {
        ...this.state,
        budget: {
          ...this.state.budget,
          modelReservations: {
            ...this.state.budget.modelReservations,
            [reservationId]: this.options.maxTokensPerInvocation,
          },
        },
      };
      try {
        await this.saveCheckpoint();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
    });
    return reservationId;
  }

  async beforeToolExecution(
    invocation: MissionModelInvocation,
    calls: MissionToolCall[],
  ): Promise<void> {
    if (calls.length === 0) return;
    await this.mutateRuntime(async () => {
      const callKeys = calls.map(
        ({callId}) =>
          `${invocation.agentId ?? invocation.stage}:` +
          `${invocation.executionId ?? 'unscoped'}:${callId}`,
      );
      const duplicate = callKeys.find((key) =>
        this.state.budget.reservedToolCallIds.includes(key),
      );
      if (duplicate) {
        if (
          invocation.resumeReservedTools &&
          callKeys.every((key) => this.state.budget.reservedToolCallIds.includes(key))
        ) {
          return;
        }

        throw new Error(
          `Refusing to replay already-reserved tool call "${duplicate}". ` +
          'Review the interrupted run before retrying with a new call ID.',
        );
      }

      const nextCount = this.state.budget.toolCallsUsed + calls.length;
      if (nextCount > this.state.budget.maxToolCalls) {
        throw new Error(
          `Mission tool-call budget exhausted before ${invocation.stage} could execute ` +
          `${calls.length} additional call(s).`,
        );
      }

      const previousState = this.state;
      this.state = {
        ...this.state,
        budget: {
          ...this.state.budget,
          reservedToolCallIds: [
            ...this.state.budget.reservedToolCallIds,
            ...callKeys,
          ],
          toolCallsUsed: nextCount,
        },
      };
      // Persist reservations before any external side effect. Ambiguous calls
      // remain reserved after interruption and cannot be replayed automatically.
      try {
        await this.saveCheckpoint();
      } catch (error) {
        this.state = previousState;
        throw error;
      }

      for (const call of calls) {
        await this.recordEvent('tool_call', {
          ...invocation,
          ...call,
        });
      }

    });
  }

  async beginExecution(objectives?: MissionObjective[]): Promise<void> {
    await this.mutateRuntime(async () => {
      if (this.state.currentPhase !== 'COMPLETE' && this.state.currentPhase !== 'FAILED') return;
      await this.reconcileTerminalEvent();
      const nextObjectives = objectives ?? this.state.objectives.map((objective) => ({
        ...objective,
        status: 'pending' as const,
      }));
      this.state = this.createInitialState(nextObjectives);
      this.startedStages.clear();
      this.completedStages.clear();
      await this.saveCheckpoint();
      await this.recordEvent('mission_started', {
        missionId: this.state.missionId,
        objectives: this.state.objectives.length,
      });
    });
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
    const reservedTokens = Object.values(this.state.budget.modelReservations)
      .reduce((total, value) => total + value, 0);
    return {
      tokens: this.state.budget.maxTokens - this.state.budget.tokensUsed - reservedTokens,
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
    if (!latestCheckpoint.ok) {
      throw new Error(`Failed to restore mission checkpoint: ${latestCheckpoint.error}`);
    }

    if (latestCheckpoint.value) {
      this.state = latestCheckpoint.value;
      await this.reconcileModelUsageEvents();
      await this.reconcileToolReservations();
      await this.reconcileTerminalEvent();
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

    for (const [eventType, target] of [
      ['stage_started', this.startedStages],
      ['stage_completed', this.completedStages],
    ] as const) {
      const events = await this.eventStore.getByType(eventType);
      if (!events.ok) throw new Error(events.error);
      for (const event of events.value) {
        if (
          event.payload.missionId === this.state.missionId &&
          typeof event.payload.stage === 'string'
        ) {
          target.add(event.payload.stage);
        }
      }
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

  async recordMissionCompleted(): Promise<void> {
    await this.mutateRuntime(async () => {
      if (this.state.currentPhase === 'COMPLETE') {
        if (!await this.hasMissionEvent('mission_completed')) {
          await this.recordEvent('mission_completed', {
            budget: this.state.budget,
            missionId: this.state.missionId,
          });
        }

        return;
      }

      if (this.state.currentPhase === 'FAILED') {
        throw new Error(`Mission is already terminal in phase ${this.state.currentPhase}.`);
      }

      const transitionedAt = new Date().toISOString();
      this.state = {
        ...this.state,
        currentPhase: 'COMPLETE',
        lastTransitionAt: transitionedAt,
        lastTransitionReason: 'report_generated',
        objectives: this.state.objectives.map((objective) => ({
          ...objective,
          status: 'completed',
        })),
        phaseHistory: [
          ...this.state.phaseHistory,
          {phase: 'COMPLETE', reason: 'report_generated', timestamp: transitionedAt},
        ],
      };
      await this.saveCheckpoint();
      await this.recordEvent('mission_completed', {
        budget: this.state.budget,
        missionId: this.state.missionId,
      });
    });
  }

  async recordMissionFailed(reason: string): Promise<void> {
    await this.mutateRuntime(async () => {
      if (this.state.currentPhase === 'FAILED') {
        if (!await this.hasMissionEvent('mission_failed')) {
          await this.recordEvent('mission_failed', {
            missionId: this.state.missionId,
            reason: this.state.errorMessage ?? 'Mission failed before its terminal event was recorded.',
          });
        }

        return;
      }

      if (this.state.currentPhase === 'COMPLETE') {
        throw new Error(`Mission is already terminal in phase ${this.state.currentPhase}.`);
      }

      const transitionedAt = new Date().toISOString();
      this.state = {
        ...this.state,
        currentPhase: 'FAILED',
        errorMessage: reason,
        lastTransitionAt: transitionedAt,
        lastTransitionReason: 'error_occurred',
        objectives: this.state.objectives.map((objective) => ({
          ...objective,
          status: objective.status === 'completed' ? objective.status : 'blocked',
        })),
        phaseHistory: [
          ...this.state.phaseHistory,
          {phase: 'FAILED', reason: 'error_occurred', timestamp: transitionedAt},
        ],
      };
      await this.saveCheckpoint();
      await this.recordEvent('mission_failed', {missionId: this.state.missionId, reason});
    });
  }

  async recordStageCompleted(stage: string): Promise<void> {
    await this.mutateRuntime(async () => {
      if (this.completedStages.has(stage)) return;
      await this.recordEvent('stage_completed', {missionId: this.state.missionId, stage});
      this.completedStages.add(stage);
      await this.saveCheckpoint();
    });
  }

  async recordStageStarted(stage: string): Promise<void> {
    await this.mutateRuntime(async () => {
      if (this.startedStages.has(stage)) return;
      await this.recordEvent('stage_started', {missionId: this.state.missionId, stage});
      this.startedStages.add(stage);
    });
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
    const result = await this.checkpointManager.saveCheckpoint(this.state);
    if (!result.ok) throw new Error(result.error);
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
        modelReservations: {},
        reservedToolCallIds: [],
        tokensUsed: 0,
        toolCallsUsed: 0,
      },
      completedActions: [],
      confidence: 0,
      currentPhase: 'OBSERVE',
      hypotheses: [],
      lastTransitionAt: now,
      missionId: crypto.randomUUID(),
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

  private async hasMissionEvent(eventType: 'mission_completed' | 'mission_failed'): Promise<boolean> {
    const events = await this.eventStore.getByType(eventType);
    if (!events.ok) throw new Error(events.error);
    return events.value.some((event) => event.payload.missionId === this.state.missionId);
  }

  private async mutateRuntime(mutation: () => Promise<void>): Promise<void> {
    const next = this.runtimeMutation.then(mutation);
    this.runtimeMutation = next.catch(() => {});
    await next;
  }

  private async reconcileModelUsageEvents(): Promise<void> {
    const events = await this.eventStore.getByType('model_usage');
    if (!events.ok) throw new Error(events.error);
    let changed = false;
    const modelReservations = {...this.state.budget.modelReservations};
    let tokensUsed = this.state.budget.tokensUsed;
    for (const event of events.value) {
      const reservationId = event.payload.reservationId;
      const chargedTokens = event.payload.chargedTokens;
      if (
        typeof reservationId !== 'string' ||
        typeof chargedTokens !== 'number' ||
        modelReservations[reservationId] === undefined
      ) {
        continue;
      }

      delete modelReservations[reservationId];
      tokensUsed += chargedTokens;
      changed = true;
    }

    // Release checkpoint-only reservations that never produced a model_usage
    // event. A crash between the reserve-checkpoint and the charge leaves the
    // reservation persisted but the invocation never completed, so those tokens
    // were never consumed. Keeping them reserved permanently leaks budget and
    // spuriously fails the mission with budget-exhausted on the next run.
    const orphanedReservationIds = Object.keys(modelReservations);
    if (orphanedReservationIds.length > 0) {
      for (const reservationId of orphanedReservationIds) {
        delete modelReservations[reservationId];
      }
      changed = true;
    }

    if (!changed) return;
    this.state = {
      ...this.state,
      budget: {...this.state.budget, modelReservations, tokensUsed},
    };
    await this.saveCheckpoint();
  }

  private async reconcileTerminalEvent(): Promise<void> {
    if (this.state.currentPhase !== 'COMPLETE' && this.state.currentPhase !== 'FAILED') return;
    const eventType = this.state.currentPhase === 'COMPLETE'
      ? 'mission_completed'
      : 'mission_failed';
    if (await this.hasMissionEvent(eventType)) return;

    await this.recordEvent(eventType, this.state.currentPhase === 'COMPLETE'
      ? {
        budget: this.state.budget,
        missionId: this.state.missionId,
      }
      : {
        missionId: this.state.missionId,
        reason: this.state.errorMessage ?? 'Mission failed before its terminal event was recorded.',
      });
  }

  private async reconcileToolReservations(): Promise<void> {
    const events = await this.eventStore.getByType('tool_call');
    if (!events.ok) throw new Error(events.error);
    const durableCallKeys = new Set(events.value.flatMap((event) => {
      if (event.payload.missionId !== this.state.missionId) return [];
      const {agentId, callId, executionId, stage} = event.payload;
      if (typeof callId !== 'string' || typeof stage !== 'string') return [];
      return [
        `${typeof agentId === 'string' ? agentId : stage}:` +
        `${typeof executionId === 'string' ? executionId : 'unscoped'}:${callId}`,
      ];
    }));
    const reservedToolCallIds = this.state.budget.reservedToolCallIds.filter(
      (key) => durableCallKeys.has(key),
    );
    const released = this.state.budget.reservedToolCallIds.length - reservedToolCallIds.length;
    if (released === 0) return;

    this.state = {
      ...this.state,
      budget: {
        ...this.state.budget,
        reservedToolCallIds,
        toolCallsUsed: Math.max(0, this.state.budget.toolCallsUsed - released),
      },
    };
    await this.saveCheckpoint();
  }

  private async recordEvent(eventType: import('../memory/memory-schema.js').EventType, payload: Record<string, unknown>): Promise<void> {
    const result = await this.eventStore.append(eventType, {
      ...payload,
      missionId: this.state.missionId,
      missionPhase: this.state.currentPhase,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  private shouldCheckpoint(): boolean {
    // Checkpoint on significant phases
    const significantPhases: MissionPhase[] = ['VERIFY', 'REPORT', 'COMPLETE', 'FAILED'];
    return significantPhases.includes(this.state.currentPhase);
  }
}
