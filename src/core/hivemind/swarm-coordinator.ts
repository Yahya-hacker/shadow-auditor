/**
 * Swarm Coordinator - Parallel multi-agent task and execution manager.
 *
 * The coordinator now drives execution through a LangGraph supervisor graph
 * backed by PersistentCheckpointSaver. The imperative while(true) loop has been
 * replaced by checkpointed graph nodes, so orchestration state survives process
 * restarts.
 */

import { type BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ToolSet } from 'ai';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { type ShadowConfig } from '../../utils/config.js';
import { DEFAULT_MAX_TOOL_STEPS } from '../model-capabilities.js';
import { PersistentCheckpointSaver } from '../orchestrator/checkpoint-saver.js';
import {
  OrchestratorEngine,
  type OrchestratorEngineOptions,
} from '../orchestrator/orchestrator-engine.js';
import {
  type PatchProposal,
  patchProposalSchema,
  type SynthesisResult,
} from '../orchestrator/patch-competition-schema.js';
import { type EnhancedFinding } from '../output/finding-schema.js';
import { AgentWorker } from './agent-worker.js';
import { Blackboard } from './blackboard.js';
import { type AgentRole, type BlackboardState } from './hivemind-schema.js';
import {
  resolveWorkerTier,
} from './swarm-model-router.js';
import { buildSwarmSupervisor, type SwarmActivity, type SwarmCoordinatorRuntime } from './swarm-supervisor.js';

export interface SwarmCoordinatorOptions {
  allTools: ToolSet;
  auditMode?: string;
  /** Optional existing blackboard to reuse across missions */
  blackboard?: Blackboard;
  config: ShadowConfig;
  diffScopeHint?: string;
  maxToolSteps?: number;
  model: BaseChatModel;
  onReportBatch?: (
    findings: Array<{ finding: EnhancedFinding; sourceClaimId: string }>,
  ) => { added: boolean; reason?: string };
  runId: string;
  storagePath: string;
}

/**
 * Manages swarm orchestration, task dependency decomposition, parallel execution, and consensus flow.
 */
export class SwarmCoordinator implements SwarmCoordinatorRuntime {
  public readonly allTools: ToolSet;
  public readonly auditMode: string;
  public readonly config: ShadowConfig;
  public readonly diffScopeHint: string;
  public readonly model: BaseChatModel;
  onActivity?: (workerRole: AgentRole, activity: SwarmActivity) => void;
  public readonly runId: string;
  public readonly storagePath: string;
  private blackboard: Blackboard | null = null;
  private currentThreadId: string;
  private lastSynthesis: null | SynthesisResult = null;
  private readonly maxToolSteps: number;
  private readonly onReportBatch?: SwarmCoordinatorOptions['onReportBatch'];
  private userMessage = '';
  private readonly workers: Map<string, AgentWorker> = new Map();

  constructor(options: SwarmCoordinatorOptions) {
    this.config = options.config;
    this.model = options.model;
    this.maxToolSteps = options.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS;
    this.onReportBatch = options.onReportBatch;
    this.allTools = options.allTools;
    this.storagePath = options.storagePath;
    this.runId = options.runId;
    this.auditMode = options.auditMode ?? 'sast';
    this.diffScopeHint = options.diffScopeHint ?? '';
    this.blackboard = options.blackboard ?? null;
    this.currentThreadId = this.runId;
  }

  createWorker(options: {
    agentId: string;
    model: BaseChatModel;
    modelTier: ReturnType<typeof resolveWorkerTier>['modelTier'];
    role: AgentRole;
    trustScore: number;
  }): AgentWorker {
    return new AgentWorker({
      agentId: options.agentId,
      allTools: this.allTools,
      auditMode: this.auditMode,
      blackboard: this.getBlackboard(),
      diffScopeHint: this.diffScopeHint,
      maxToolSteps: this.maxToolSteps,
      model: options.model,
      modelTier: options.modelTier,
      onReportBatch: this.onReportBatch,
      providerHint: this.config.provider,
      role: options.role,
      trustScore: options.trustScore,
    });
  }

  async executeMission(
    userMessage: string,
    onActivity?: (workerRole: AgentRole, activity: SwarmActivity) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    this.userMessage = userMessage;
    this.onActivity = onActivity;

    // 1. Initialize Blackboard (reuse existing if provided for cross-mission persistence)
    if (!this.blackboard) {
      this.blackboard = await Blackboard.create({
        heartbeatTimeout: 60_000,
        runId: this.runId,
        storagePath: this.storagePath,
      });
    }

    const blackboard = this.blackboard;
    const existingTasks = blackboard.getTaskGraph().getAllTasks();
    if (
      existingTasks.length > 0 &&
      existingTasks.every((task) => ['cancelled', 'completed', 'failed'].includes(task.status))
    ) {
      this.currentThreadId = `${this.runId}:mission:${randomUUID()}`;
    }

    // 2. Build the checkpointed LangGraph supervisor.
    const checkpointer = new PersistentCheckpointSaver({ storagePath: this.storagePath });
    await checkpointer.initialize();
    await checkpointer.prune(this.currentThreadId);

    const supervisor = buildSwarmSupervisor({
      blackboard,
      checkpointer,
      coordinator: this,
    });

    // 3. Run the graph. Resuming from a checkpoint is automatic when the same
    //    thread_id/run_id is reused.
    let finalState: unknown;
    try {
      finalState = await supervisor.invoke(
        {},
        { configurable: { thread_id: this.currentThreadId }, signal },
      );
    } finally {
      await checkpointer.prune(this.currentThreadId);
      if (signal?.aborted) this.terminateAllWorkers();
    }

    // 4. Extract the final report from the reporter task result.
    const finalBlackboard = (finalState as { blackboard?: BlackboardState }).blackboard ?? {
      tasks: [],
    };
    const reportTask = finalBlackboard.tasks.find((t) => t.taskType === 'report');
    if (!reportTask || reportTask.status !== 'completed') {
      throw new Error(
        `Swarm reporting did not complete${reportTask?.errorMessage ? `: ${reportTask.errorMessage}` : '.'}`,
      );
    }

    const reporterOutput = typeof reportTask?.result === 'string' ? reportTask.result : '';

    const report = reporterOutput || 'No report generated by reporting worker.';
    return this.lastSynthesis
      ? `${report}\n\n## Patch competition\n${this.lastSynthesis.summary}`
      : report;
  }

  async finalizePatchCompetition(results: unknown[]): Promise<null | SynthesisResult> {
    const proposals = results
      .map((result) => parsePatchProposalResult(result))
      .filter((proposal): proposal is PatchProposal => proposal !== null);
    if (proposals.length === 0) return null;

    this.lastSynthesis = this.runPatchCompetition(proposals);
    await fs.mkdir(this.storagePath, { recursive: true });
    await fs.writeFile(
      path.join(this.storagePath, 'patch-synthesis.json'),
      `${JSON.stringify(this.lastSynthesis, null, 2)}\n`,
      'utf8',
    );
    return this.lastSynthesis;
  }

  findIdleWorker(role: AgentRole, blackboard: Blackboard, excludedWorkers?: Set<string>): AgentWorker | undefined {
    return [...this.workers.values()].find((w) => {
      if (excludedWorkers?.has(w.agentId)) return false;
      const active = blackboard.getActiveAgents().find((a) => a.agentId === w.agentId);
      return w.role === role && active?.status === 'idle';
    });
  }

  /**
   * Look up a live worker by its agent ID.
   *
   * Used by the supervisor's per-task `executeTask` graph node to resolve the
   * worker that claimed a task. Returns undefined when the worker has not been
   * (re-)created — e.g. immediately after a fresh-process resume before
   * `spawnWorkers` reconciliation has run.
   */
  findWorkerByAgentId(agentId: string): AgentWorker | undefined {
    return this.workers.get(agentId);
  }

  getBlackboard(): Blackboard {
    if (!this.blackboard) {
      throw new Error('Blackboard has not been initialized');
    }

    return this.blackboard;
  }

  getConfig(): ShadowConfig {
    return this.config;
  }

  getModel(): BaseChatModel {
    return this.model;
  }

  getOnActivity(): SwarmCoordinatorRuntime['onActivity'] | undefined {
    return this.onActivity;
  }

  getUserMessage(): string {
    return this.userMessage;
  }

  isPatchEnabled(): boolean {
    return this.config.swarm?.roles?.includes('patch-engineer') ?? false;
  }

  registerWorker(agentId: string, worker: AgentWorker): void {
    this.workers.set(agentId, worker);
  }

  /**
   * Restart the QA / verification mission by resetting all failed verifier
   * tasks and re-invoking the supervisor graph. This is the primary recovery
   * path after a major refactoring operation when the QA agent (verifier)
   * fails to complete its assigned work.
   *
   * On a fresh restart (no existing blackboard, or all tasks terminal), this
   * clears state and re-plans the full mission. On a partial failure, only
   * the verifier task is reset while preserving completed upstream work.
   */
  async restartMission(): Promise<string> {
    const blackboard = this.getBlackboard();
    const taskGraph = blackboard.getTaskGraph();

    // Reset all failed/cancelled verifier tasks so the QA cycle restarts.
    const resetCount = taskGraph.resetTasksByRole('verifier');

    // If no verifier tasks to reset but mission is stuck, do a full restart
    // by clearing all tasks and forcing re-planning.
    const allTasks = taskGraph.getAllTasks();
    const allTerminal = allTasks.length > 0 &&
      allTasks.every((t) =>
        t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
      );

    if (resetCount === 0 && allTerminal) {
      // Full restart: import empty task list to force planMission to re-plan.
      taskGraph.importTasks([]);

      // Also re-register agents (clear and re-spawn).
      // The spawnWorkers node will handle this when it sees no agents.
    }

    // Build and run a fresh supervisor graph invocation.
    // Using the same runId (thread_id) means checkpoints are resumed,
    // but the dispatch node will now see the reset verifier task as claimable.
    const checkpointer = new PersistentCheckpointSaver({ storagePath: this.storagePath });
    await checkpointer.initialize();
    await checkpointer.prune(this.currentThreadId);

    const supervisor = buildSwarmSupervisor({
      blackboard,
      checkpointer,
      coordinator: this,
    });

    const finalState = await supervisor.invoke(
      {},
      { configurable: { thread_id: this.currentThreadId } },
    );

    const finalBlackboard = (finalState as { blackboard?: import('./hivemind-schema.js').BlackboardState }).blackboard ?? {
      tasks: [],
    };
    const reportTask = finalBlackboard.tasks.find((t) => t.taskType === 'report');
    if (!reportTask || reportTask.status !== 'completed') {
      throw new Error(
        `Swarm reporting did not complete${reportTask?.errorMessage ? `: ${reportTask.errorMessage}` : '.'}`,
      );
    }

    const reporterOutput = typeof reportTask?.result === 'string' ? reportTask.result : '';

    const report = reporterOutput || 'No report generated by reporting worker.';
    return this.lastSynthesis
      ? `${report}\n\n## Patch competition\n${this.lastSynthesis.summary}`
      : report;
  }

  /**
   * Run the patch competition pipeline on completed patch task results.
   *
   * Collects PatchProposals from all completed patch-type tasks, feeds them
   * into the OrchestratorEngine, and returns the SynthesisResult. This is
   * called during cleanup when multiple agents have produced competing patches.
   *
   */
  runPatchCompetition(
    proposals: PatchProposal[],
    options?: OrchestratorEngineOptions,
  ): SynthesisResult {
    const engine = new OrchestratorEngine(options);
    return engine.evaluate(proposals);
  }

  terminateAllWorkers(): void {
    for (const worker of this.workers.values()) {
      worker.terminate();
    }

    this.workers.clear();
  }
}

export function parsePatchProposalResult(result: unknown): null | PatchProposal {
  let candidate = result;
  if (typeof result === 'string') {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(result)?.[1];
    const source = fenced ?? result.slice(result.indexOf('{'), result.lastIndexOf('}') + 1);
    if (!source.trim()) return null;
    try {
      candidate = JSON.parse(source);
    } catch {
      return null;
    }
  }

  const parsed = patchProposalSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
