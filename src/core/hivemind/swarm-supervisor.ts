/**
 * Swarm Supervisor - LangGraph-native orchestration of the multi-agent swarm.
 *
 * The supervisor is a checkpointed StateGraph. Parallel agent routing is
 * expressed natively with the `Send` API: a `dispatch` node claims+starts
 * claimable tasks, then a conditional edge fans out one `Send` per in-progress
 * task to a parallel `executeTask` node. LangGraph barriers the fan-out
 * (map-reduce join), so each `executeTask` completion is its own checkpoint
 * boundary — per-task progress survives process restarts through
 * PersistentCheckpointSaver, replacing the old imperative Promise.all loop.
 *
 * Only serializable blackboard state crosses the checkpoint boundary. Runtime
 * handles (workers) live on the SwarmCoordinator and are reconciled against
 * persisted agent registrations on resume (see `spawnWorkers`).
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { END, Send, START, StateGraph } from '@langchain/langgraph';

import type { NormalizedTokenUsage } from '../usage.js';
import type { AgentWorker } from './agent-worker.js';
import type { Blackboard } from './blackboard.js';
import type { AgentRole, BlackboardState, Task } from './hivemind-schema.js';

import { debugLog } from '../../utils/debug-logger.js';
import { AgentState } from '../graph/state.js';
import {isMissionAccountingFailure} from '../orchestrator/mission-runtime.js';
import {
  type PatchProposal,
  patchProposalAgentRoleSchema,
  patchProposalSchema,
} from '../orchestrator/patch-competition-schema.js';
import {
  resolveWorkerModel,
  resolveWorkerTier,
  type SwarmModelOverrides,
} from './swarm-model-router.js';

type GraphState = typeof AgentState.State;

export interface SwarmSupervisorOptions {
  allTools: SwarmCoordinatorOptions['allTools'];
  auditMode?: string;
  blackboard: Blackboard;
  config: SwarmCoordinatorOptions['config'];
  diffScopeHint?: string;
  model: SwarmCoordinatorOptions['model'];
  runId: string;
}

const MAX_FAILED_RETRIES = 3;

type TaskGraph = ReturnType<Blackboard['getTaskGraph']>;

/**
 * Compact, serializable snapshot of swarm progress, emitted through the
 * activity channel for the UI to render a live swarm panel / status bar.
 */
export interface SwarmStateSnapshot {
  agents: Array<{ agentId: string; role: AgentRole; status: string }>;
  claims: number;
  consensus: number;
  runId: string;
  tasks: Array<{ requiredRole?: string; status: string; taskId: string; taskType: string }>;
  taskStats: Record<string, number>;
}

/**
 * Activity payload the supervisor emits to the coordinator's `onActivity`.
 * Extends the worker activity shape with an optional structured swarm snapshot
 * (carried on `swarm_state` events) so the UI can render live swarm state
 * without parsing a message string.
 */
export interface SwarmActivity {
  args?: unknown;
  kind: string;
  message: string;
  result?: unknown;
  succeeded?: boolean;
  swarmState?: SwarmStateSnapshot;
  toolCallId?: string;
  toolName?: string;
  usage?: NormalizedTokenUsage;
}

/**
 * Build the LangGraph supervisor that drives the swarm.
 *
 * The graph owns the lifecycle of the mission: plan, spawn, dispatch,
 * execute (parallel fan-out), evaluate consensus, and cleanup.
 */
export function buildSwarmSupervisor(options: {
  blackboard: Blackboard;
  checkpointer: BaseCheckpointSaver;
  coordinator: SwarmCoordinatorRuntime;
}) {
  const { blackboard, checkpointer, coordinator } = options;

  async function planMission(): Promise<Partial<GraphState>> {
    const taskGraph = blackboard.getTaskGraph();

    const existingTasks = taskGraph.getAllTasks();
    if (existingTasks.length > 0) {
      const previousMissionFinished = existingTasks.every((task) =>
        task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
      );
      if (!previousMissionFinished) {
        return { blackboard: blackboardToState(blackboard) };
      }

      taskGraph.importTasks([]);
      // A finished mission must not leak its claims, conflicts, consensus
      // records, or agent registrations into the next one. Otherwise the
      // reporter re-reports the previous run's verified/consensus findings on
      // a new codebase or refactor, and stale agents accumulate.
      blackboard.resetForNewMission();
    }

    const userMessage = coordinator.getUserMessage();

    const reconRes = taskGraph.createTask({
      description: 'Discover entry points and codebase structure',
      parameters: { userMessage },
      priority: 'high',
      requiredRole: 'recon',
      taskType: 'recon',
    });
    if (!reconRes.ok) throw new Error(reconRes.error);
    const reconTaskId = reconRes.value.taskId;

    const taintRes = taskGraph.createTask({
      description: 'Trace data flow from input sources to sinks',
      parameters: {},
      priority: 'high',
      requiredRole: 'taint-tracer',
      taskType: 'taint',
    });
    if (!taintRes.ok) throw new Error(taintRes.error);
    const taintTaskId = taintRes.value.taskId;

    const exploitRes = taskGraph.createTask({
      dependencies: [reconTaskId, taintTaskId],
      description: 'Analyze potential vulnerability candidates and classify CWEs',
      parameters: {},
      priority: 'high',
      requiredRole: 'exploit-analyst',
      taskType: 'exploit',
    });
    if (!exploitRes.ok) throw new Error(exploitRes.error);
    const exploitTaskId = exploitRes.value.taskId;

    const verifyRes = taskGraph.createTask({
      dependencies: [exploitTaskId],
      description: 'Verify candidate findings using code evidence gates',
      parameters: {},
      priority: 'high',
      requiredRole: 'verifier',
      taskType: 'verify',
    });
    if (!verifyRes.ok) throw new Error(verifyRes.error);
    const verifyTaskId = verifyRes.value.taskId;

    const finalReporterDeps = [verifyTaskId];

    const patchEnabled = coordinator.isPatchEnabled();
    if (patchEnabled) {
      const patchPerspectives = [
        {
          agentRole: 'security_boundaries',
          description: 'Design the least-privilege security fix and verify it against tests',
        },
        {
          agentRole: 'language_patterns',
          description: 'Design an idiomatic, maintainable security fix and verify it against tests',
        },
        {
          agentRole: 'tui_state_machine',
          description: 'Design a regression-resistant integration fix and verify it against tests',
        },
      ] as const;
      for (const perspective of patchPerspectives) {
        const patchRes = taskGraph.createTask({
          dependencies: [verifyTaskId],
          description: perspective.description,
          parameters: {
            patchPerspective: perspective.agentRole,
            proposalRequirement: 'Return one tested PatchProposal matching this exact agentRole.',
          },
          priority: 'medium',
          requiredRole: 'patch-engineer',
          taskType: `patch:${perspective.agentRole}`,
        });
        if (!patchRes.ok) throw new Error(patchRes.error);
        finalReporterDeps.push(patchRes.value.taskId);
      }
    }

    const reportRes = taskGraph.createTask({
      dependencies: finalReporterDeps,
      description: 'Compile security analysis report',
      parameters: {},
      priority: 'high',
      requiredRole: 'reporter',
      taskType: 'report',
    });
    if (!reportRes.ok) throw new Error(reportRes.error);

    return { blackboard: blackboardToState(blackboard) };
  }

  async function spawnWorkers(): Promise<Partial<GraphState>> {
    // Reconcile live workers against persisted agent registrations. On a fresh
    // run there are no registered agents and we spawn one worker per role. On
    // a resume from checkpoint, registered agents already exist (loaded from
    // the snapshot) but the in-memory workers Map is empty — we must re-create
    // a worker for each registered agent so task dispatch can proceed. This is
    // what makes a crashed run actually continue instead of stalling.
    const registered = blackboard.getRegisteredAgents();

    if (registered.length === 0) {
      const rolesToSpawn: AgentRole[] = ['recon', 'taint-tracer', 'exploit-analyst', 'verifier', 'reporter'];
      if (coordinator.isPatchEnabled()) {
        rolesToSpawn.push('patch-engineer', 'patch-engineer', 'patch-engineer');
      }

      for (const role of rolesToSpawn) {
        const regRes = blackboard.registerAgent(role, ['typescript', 'security']);
        if (!regRes.ok) throw new Error(regRes.error);
        await ensureWorkerForAgent(regRes.value.agentId, regRes.value.role);
      }

      return { blackboard: blackboardToState(blackboard) };
    }

    // Resume path: re-create any missing live workers for existing agents.
    for (const agent of registered) {
      if (coordinator.findWorkerByAgentId(agent.agentId)) continue;
      await ensureWorkerForAgent(agent.agentId, agent.role);
    }

    return { blackboard: blackboardToState(blackboard) };
  }

  /**
   * Create (or re-create) a worker for an existing agent registration,
   * resolving its model/tier/trust from config overrides.
   */
  async function ensureWorkerForAgent(agentId: string, role: AgentRole): Promise<void> {
    const overrides = coordinator.getConfig().swarm?.modelOverrides as SwarmModelOverrides | undefined;
    const workerModel = resolveWorkerModel(role, coordinator.getModel(), overrides);
    const { modelTier, trustScore } = resolveWorkerTier(
      role,
      coordinator.getConfig().provider,
      coordinator.getConfig().model,
      overrides,
    );
    const trustResult = blackboard.setAgentTrustScore(agentId, trustScore);
    if (!trustResult.ok) {
      throw new Error(trustResult.error);
    }

    const worker = coordinator.createWorker({
      agentId,
      model: workerModel,
      modelTier,
      role,
      trustScore,
    });
    coordinator.registerWorker(agentId, worker);
  }

  /**
   * Dispatch node: reset stale in_progress tasks (crash recovery), auto-retry
   * failed verifier tasks (QA recovery), then claim and start every claimable
   * task that has an idle worker. The conditional edge `routeFromDispatch` then
   * fans out one Send per in_progress task.
   */
  async function dispatch(): Promise<Partial<GraphState>> {
    const taskGraph = blackboard.getTaskGraph();
    const activeAgents = blackboard.getActiveAgents();
    const maxWorkers = Math.max(1, coordinator.getConfig().swarm?.maxWorkers ?? 6);

    releaseStaleTasks(taskGraph, activeAgents);
    retryFailedVerifierTasks(taskGraph);
    claimAvailableTasks({ blackboard, coordinator, maxWorkers, taskGraph });

    return { blackboard: blackboardToState(blackboard) };
  }

  /**
   * executeTask node (one per Send): run a single claimed task on its worker.
   * Each completion is a checkpoint boundary, so per-task progress survives
   * crashes.
   *
   * Implements Lazy Hydration: if the worker is not found in the in-memory
   * Map (which is empty after a process restart or checkpoint resume), the
   * worker is re-instantiated on the fly from the persisted Blackboard agent
   * registration. This prevents the old behavior where all in-progress tasks
   * would silently freeze because `findWorkerByAgentId` returned undefined.
   */
  async function executeTask(state: GraphState, config?: RunnableConfig): Promise<Partial<GraphState>> {
    const { agentId, taskId } = state;
    const taskGraph = blackboard.getTaskGraph();
    if (!taskId || !agentId) {
      // Guard against stale tasks with empty identifiers. If we know the
      // taskId, fail it explicitly so dependents/deadlock logic can react.
      if (taskId) {
        taskGraph.failTask(taskId, 'executeTask received empty agentId — agent unavailable');
      } else if (agentId) {
        debugLog(`[SwarmCoordinator] executeTask received empty taskId for agent ${agentId}`);
      } else {
        debugLog('[SwarmCoordinator] executeTask received with empty taskId and agentId');
      }

      return { blackboard: blackboardToState(blackboard) };
    }

    const task = taskGraph.getTask(taskId);
    let worker = coordinator.findWorkerByAgentId(agentId);

    // ── Lazy Hydration ──────────────────────────────────────────────────
    // On process restart or checkpoint resume, the in-memory workers Map is
    // empty, but the Blackboard persists agent registrations. Re-create the
    // worker on the fly so in-progress tasks don't silently freeze.
    if (!worker) {
      const registeredAgent = blackboard.getActiveAgents().find((a) => a.agentId === agentId);
      if (registeredAgent) {
        debugLog(`[SwarmCoordinator] Lazy-hydrating worker for agent ${agentId} (${registeredAgent.role}) after resume`);
        try {
          await ensureWorkerForAgent(registeredAgent.agentId, registeredAgent.role);
          worker = coordinator.findWorkerByAgentId(agentId);
        } catch (error) {
              // Surface the real cause rather than a generic "unavailable" reason.
              // The retry policy should distinguish a transient provider/model
              // failure (permanent hydration blocker) from a genuinely absent
              // worker. Marking the task failed with the underlying error lets
              // that policy decide whether to retry.
              const reason = error instanceof Error ? error.message : String(error);
              debugLog(`[SwarmCoordinator] Lazy hydration failed for agent ${agentId}: ${reason}`);
              if (task) {
                taskGraph.failTask(taskId, `Hydration failed for agent ${agentId}: ${reason}`);
              }
            }
          }
        }

        if (!task || !worker) {
          if (!task) {
            debugLog(`[SwarmCoordinator] Task ${taskId} not found in task graph — may have been cancelled or already completed`);
          }

          if (task && !worker) {
            debugLog(`[SwarmCoordinator] Worker ${agentId} unavailable for task ${taskId} (${task.taskType}) — marking task as failed`);
            // Only mark permanently failed if this wasn't already failed by a
            // hydration error above (which carries a more specific reason).
            if (taskGraph.getTask(taskId)?.status !== 'failed') {
              taskGraph.failTask(taskId, `Worker ${agentId} unavailable`);
            }
          }

      return { blackboard: blackboardToState(blackboard) };
    }

    try {
      await executeTaskWithWorker({
        blackboard,
        onActivity: coordinator.getOnActivity(),
        signal: config?.signal,
        task,
        worker,
      });
    } catch (error) {
      debugLog(`[SwarmCoordinator] Task ${taskId} failed: ${error}`);
      taskGraph.failTask(taskId, error instanceof Error ? error.message : String(error));
    }

    return { blackboard: blackboardToState(blackboard) };
  }

  /**
   * evaluateConsensus node (join): close expired consensus proposals, emit a
   * swarm-state snapshot for the UI, then route to the next dispatch round or
   * terminate. Idempotent — safe even if LangGraph invokes it once per joined
   * fan-out branch.
   */
  async function evaluateConsensus(): Promise<Partial<GraphState>> {
    blackboard.expireConsensusProposals();
    const taskGraph = blackboard.getTaskGraph();
    const tasks = taskGraph.getAllTasks();
    const hasActiveWork = tasks.some((task) =>
      task.status === 'in_progress' ||
      task.status === 'claimed' ||
      (task.status === 'pending' && task.dependencies.every(
        (dependencyId) => taskGraph.getTask(dependencyId)?.status === 'completed',
      ))
    );
    if (!hasActiveWork) {
      for (const task of tasks) {
        if (task.status === 'blocked' || task.status === 'pending') {
          taskGraph.cancelTask(task.taskId);
        }
      }
    }

    const onActivity = coordinator.getOnActivity();
    if (onActivity) {
      const snapshot = buildSwarmStateSnapshot(blackboard);
      const total = Object.values(snapshot.taskStats).reduce((a, b) => a + b, 0);
      onActivity('orchestrator', {
        kind: 'swarm_state',
        message: `swarm: ${snapshot.taskStats.in_progress ?? 0} active, ${snapshot.taskStats.completed ?? 0}/${total} done, ${snapshot.claims} claims, ${snapshot.consensus} consensus`,
        swarmState: snapshot,
      });
    }

    await blackboard.saveSnapshot();
    return { blackboard: blackboardToState(blackboard) };
  }

  async function cleanup(): Promise<Partial<GraphState>> {
    // The patch competition is an optional enhancement on top of a completed
    // mission. If a single patch-engineer worker failed to produce the exact
    // proposal shape we require, we must NOT fail the whole mission - the
    // security report has already been produced and the work done elsewhere is
    // valid. Treat a broken/missing competition as "skipped": log it and return
    // the report without a synthesis section.
    try {
      const patchProposals = collectPatchCompetitionProposals(blackboard);
      const synthesis = await coordinator.finalizePatchCompetition(patchProposals);
      if (synthesis) {
        coordinator.getOnActivity()?.('orchestrator', {
          kind: 'patch_competition',
          message: synthesis.summary,
        });
      }
    } catch (error) {
      coordinator.getOnActivity()?.('orchestrator', {
        kind: 'patch_competition',
        message: `Patch competition skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    coordinator.terminateAllWorkers();
    await blackboard.saveSnapshot();
    return { blackboard: blackboardToState(blackboard) };
  }

  const workflow = new StateGraph(AgentState)
    .addNode('planMission', planMission)
    .addNode('spawnWorkers', spawnWorkers)
    .addNode('dispatch', dispatch)
    .addNode('executeTask', executeTask)
    .addNode('evaluateConsensus', evaluateConsensus)
    .addNode('cleanup', cleanup)
    .addEdge(START, 'planMission')
    .addEdge('planMission', 'spawnWorkers')
    .addEdge('spawnWorkers', 'dispatch')
    .addConditionalEdges('dispatch', routeFromDispatch)
    .addEdge('executeTask', 'evaluateConsensus')
    .addConditionalEdges('evaluateConsensus', routeAfterEvaluate)
    .addEdge('cleanup', END);

  return workflow.compile({ checkpointer });
}

export function collectPatchCompetitionProposals(blackboard: Blackboard): PatchProposal[] {
  const patchTasks = blackboard.getTaskGraph().getAllTasks().filter(
    (task) => task.requiredRole === 'patch-engineer' || task.taskType.includes('patch'),
  );
  if (patchTasks.length === 0) return [];

  const expectedRoles = new Set(patchProposalAgentRoleSchema.options);
  if (patchTasks.length !== expectedRoles.size) {
    throw new Error(
      `Patch competition requires ${expectedRoles.size} completed perspectives; found ${patchTasks.length}.`,
    );
  }

  const claims = blackboard.getAllClaims().filter((claim) => claim.claimType === 'patch_proposal');
  const proposals = patchTasks.map((task) => {
    if (task.status !== 'completed' || !task.assignedAgent) {
      throw new Error(`Patch task ${task.taskId} did not complete with an assigned worker.`);
    }

    const expectedRoleResult = patchProposalAgentRoleSchema.safeParse(
      task.parameters.patchPerspective,
    );
    if (!expectedRoleResult.success) {
      throw new Error(`Patch task ${task.taskId} has an invalid patchPerspective.`);
    }

    const candidates = claims
      .filter((claim) => claim.agentId === task.assignedAgent)
      .map((claim) => patchProposalSchema.safeParse(claim.data))
      .filter((result) => result.success && result.data.agentRole === expectedRoleResult.data)
      .map((result) => result.data);
    const proposal = candidates[0];
    if (!proposal || candidates.length !== 1) {
      throw new Error(
        `Patch task ${task.taskId} must submit exactly one valid ${expectedRoleResult.data} proposal; found ${candidates.length}.`,
      );
    }

    return proposal;
  });

  const submittedRoles = new Set(proposals.map((proposal) => proposal.agentRole));
  for (const role of expectedRoles) {
    if (!submittedRoles.has(role)) {
      throw new Error(`Patch competition is missing the ${role} proposal.`);
    }
  }

  return proposals;
}

/**
 * Conditional edge after dispatch: fan out one Send per in_progress task to a
 * parallel `executeTask` node instance. If nothing is in progress, fall
 * through to consensus evaluation. LangGraph barriers the fan-out — the join
 * edge `executeTask -> evaluateConsensus` runs evaluateConsensus once after
 * all parallel instances complete.
 */
function routeFromDispatch(state: GraphState): Array<Send> | string {
  const inProgress = state.blackboard.tasks.filter(
    (t) => t.status === 'in_progress' && t.assignedAgent,
  );
  if (inProgress.length === 0) {
    return 'evaluateConsensus';
  }

  return inProgress.map(
    (t) => new Send('executeTask', { agentId: t.assignedAgent!, taskId: t.taskId }),
  );
}

/**
 * Conditional edge after consensus evaluation: continue dispatching if there is
 * in-progress or claimable work; clean up if every task is terminal; otherwise
 * the swarm is deadlocked and we stop.
 */
function routeAfterEvaluate(state: GraphState): string {
  const tasks = state.blackboard.tasks;

  if (
    tasks.length > 0 &&
    tasks.every(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    )
  ) {
    return 'cleanup';
  }

  const hasInProgress = tasks.some((t) => t.status === 'in_progress');
  const hasClaimable = tasks.some(
    (t) =>
      t.status === 'pending' &&
      t.dependencies.every((d) => tasks.find((x) => x.taskId === d)?.status === 'completed'),
  );

  if (hasInProgress || hasClaimable) {
    return 'dispatch';
  }

  return 'cleanup';
}

async function executeTaskWithWorker(
  options: {
    blackboard: Blackboard;
    onActivity?: SwarmCoordinatorRuntime['onActivity'];
    signal?: AbortSignal;
    task: Task;
    worker: AgentWorker;
  },
): Promise<void> {
  const { blackboard, onActivity, signal, task, worker } = options;
  const result = await worker.executeTask(task, (activity) => {
    onActivity?.(worker.role, activity);
  }, signal);
  blackboard.completeTask(task.taskId, result);
}

export function releaseStaleTasks(
  taskGraph: TaskGraph,
  activeAgents: ReturnType<Blackboard['getActiveAgents']>,
): void {
  for (const task of taskGraph.getTasksByStatus('in_progress')) {
    const agent = activeAgents.find((candidate) => candidate.agentId === task.assignedAgent);
    // Only release when the assigned agent is actually gone or offline. A live
    // worker heartbeats throughout long tool runs, so a task that has merely
    // been running for a while must NOT be released — doing so would re-dispatch
    // it to a second worker and run the same task twice in parallel, racing
    // completeTask and marking the loser failed.
    if (!agent || agent.status === 'offline') {
      taskGraph.releaseTask(task.taskId);
    }
  }
}

export function retryFailedVerifierTasks(taskGraph: TaskGraph): void {
  for (const task of taskGraph.getTasksByStatus('failed')) {
    if (task.requiredRole !== 'verifier') continue;
    if (isMissionAccountingFailure(task.errorMessage ?? '')) continue;
    const retryCount = (task.parameters?._retryCount as number) ?? 0;
    if (retryCount >= MAX_FAILED_RETRIES) continue;
    const resetResult = taskGraph.resetTask(task.taskId);
    if (!resetResult.ok) continue;
    const reset = resetResult.value;
    taskGraph.updateTaskParameters(reset.taskId, {
      ...reset.parameters,
      _retryCount: retryCount + 1,
    });
    debugLog(
      `[SwarmCoordinator] Auto-retry verifier task ${task.taskId} ` +
      `(attempt ${retryCount + 1}/${MAX_FAILED_RETRIES}): ${task.errorMessage ?? 'unknown error'}`,
    );
  }
}

function claimAvailableTasks(options: {
  blackboard: Blackboard;
  coordinator: SwarmCoordinatorRuntime;
  maxWorkers: number;
  taskGraph: TaskGraph;
}): void {
  const { blackboard, coordinator, maxWorkers, taskGraph } = options;
  const assignedWorkers = new Set<string>();
  let availableSlots = Math.max(
    0,
    maxWorkers - taskGraph.getTasksByStatus('in_progress').length,
  );
  for (const task of taskGraph.getClaimableTasks()) {
    if (availableSlots === 0) break;
    if (!task.requiredRole) continue;
    const idleWorker = coordinator.findIdleWorker(task.requiredRole, blackboard, assignedWorkers);
    if (!idleWorker) continue;
    const claimResult = taskGraph.claimTask(task.taskId, idleWorker.agentId);
    if (!claimResult.ok) continue;
    const startResult = taskGraph.startTask(task.taskId);
    if (!startResult.ok) continue;
    assignedWorkers.add(idleWorker.agentId);
    availableSlots--;
  }
}

function blackboardToState(blackboard: Blackboard): BlackboardState {
  const taskGraph = blackboard.getTaskGraph();
  return {
    agents: blackboard.getActiveAgents(),
    claims: blackboard.getAllClaims(),
    conflicts: blackboard.getAllConflicts(),
    consensusRecords: blackboard.getConsensusRecords(),
    runId: blackboard.getRunId(),
    schemaVersion: '1.0.0',
    snapshotAt: new Date().toISOString(),
    tasks: taskGraph.getAllTasks(),
  };
}

function buildSwarmStateSnapshot(blackboard: Blackboard): SwarmStateSnapshot {
  const taskGraph = blackboard.getTaskGraph();
  return {
    agents: blackboard.getRegisteredAgents().map((a) => ({
      agentId: a.agentId,
      role: a.role,
      status: a.status,
    })),
    claims: blackboard.getAllClaims().length,
    consensus: blackboard.getConsensusRecords().length,
    runId: blackboard.getRunId(),
    tasks: taskGraph.getAllTasks().map((t) => ({
      requiredRole: t.requiredRole,
      status: t.status,
      taskId: t.taskId,
      taskType: t.taskType,
    })),
    taskStats: taskGraph.getStats(),
  };
}

import type { SwarmCoordinatorOptions } from './swarm-coordinator.js';

/**
 * Runtime interface exposed by SwarmCoordinator to the supervisor graph.
 */
export interface SwarmCoordinatorRuntime {
  allTools: SwarmCoordinatorOptions['allTools'];
  auditMode: string;
  config: SwarmCoordinatorOptions['config'];
  createWorker: (options: {
    agentId: string;
    model: ReturnType<typeof resolveWorkerModel>;
    modelTier: ReturnType<typeof resolveWorkerTier>['modelTier'];
    role: AgentRole;
    trustScore: number;
  }) => AgentWorker;
  diffScopeHint: string;
  finalizePatchCompetition: (results: unknown[]) => Promise<import('../orchestrator/patch-competition-schema.js').SynthesisResult | null>;
  findIdleWorker: (role: AgentRole, blackboard: Blackboard, excludedWorkers?: Set<string>) => AgentWorker | undefined;
  findWorkerByAgentId: (agentId: string) => AgentWorker | undefined;
  getConfig: () => SwarmCoordinatorOptions['config'];
  getModel: () => SwarmCoordinatorOptions['model'];
  getOnActivity: () => SwarmCoordinatorRuntime['onActivity'] | undefined;
  getUserMessage: () => string;
  isPatchEnabled: () => boolean;
  onActivity?: (workerRole: AgentRole, activity: SwarmActivity) => void;
  registerWorker: (agentId: string, worker: AgentWorker) => void;
  terminateAllWorkers: () => void;
}
