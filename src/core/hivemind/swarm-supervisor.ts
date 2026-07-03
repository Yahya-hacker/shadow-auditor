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

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { END, Send, START, StateGraph } from '@langchain/langgraph';

import type { ShadowConfig } from '../../utils/config.js';
import type { AgentWorker } from './agent-worker.js';
import type { Blackboard } from './blackboard.js';
import type { AgentRole, BlackboardState, Task } from './hivemind-schema.js';

import { AgentState } from '../graph/state.js';
import {
  resolveWorkerModel,
  resolveWorkerTier,
  type SwarmModelOverrides,
} from './swarm-model-router.js';
import { debugLog } from '../../utils/debug-logger.js';

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

// Maximum time a task can remain in_progress before the supervisor resets it.
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000; // 10 minutes

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
  kind: string;
  message: string;
  swarmState?: SwarmStateSnapshot;
  toolName?: string;
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

    // Idempotent: if the graph already has tasks, do not re-plan.
    if (taskGraph.getAllTasks().length > 0) {
      return { blackboard: blackboardToState(blackboard) };
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
      dependencies: [reconTaskId],
      description: 'Trace data flow from input sources to sinks',
      parameters: {},
      priority: 'high',
      requiredRole: 'taint-tracer',
      taskType: 'taint',
    });
    if (!taintRes.ok) throw new Error(taintRes.error);
    const taintTaskId = taintRes.value.taskId;

    const exploitRes = taskGraph.createTask({
      dependencies: [taintTaskId],
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
    let patchTaskId = '';
    if (patchEnabled) {
      const patchRes = taskGraph.createTask({
        dependencies: [verifyTaskId],
        description: 'Generate code patches and verify them against tests',
        parameters: {},
        priority: 'medium',
        requiredRole: 'patch-engineer',
        taskType: 'patch',
      });
      if (patchRes.ok) {
        patchTaskId = patchRes.value.taskId;
        finalReporterDeps.push(patchTaskId);
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
        rolesToSpawn.push('patch-engineer');
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
   * Dispatch node: reset stale in_progress tasks (crash recovery), then claim
   * and start every claimable task that has an idle worker. The conditional
   * edge `routeFromDispatch` then fans out one Send per in_progress task.
   */
  async function dispatch(): Promise<Partial<GraphState>> {
    const taskGraph = blackboard.getTaskGraph();
    const activeAgents = blackboard.getActiveAgents();
    const assignedWorkers = new Set<string>();

    // Release in_progress tasks whose agents have gone offline or run too long.
    // On resume from a crash, in-memory promises were lost but the blackboard
    // still shows these as in_progress; releasing them makes them claimable
    // again so the re-created workers can pick them up.
    for (const task of taskGraph.getTasksByStatus('in_progress')) {
      const agent = activeAgents.find((a) => a.agentId === task.assignedAgent);
      const runningTooLong =
        task.updatedAt && Date.now() - new Date(task.updatedAt).getTime() > STALE_IN_PROGRESS_MS;
      if (!agent || agent.status === 'offline' || runningTooLong) {
        taskGraph.releaseTask(task.taskId);
      }
    }

    for (const task of taskGraph.getClaimableTasks()) {
      if (!task.requiredRole) continue;
      const idleWorker = coordinator.findIdleWorker(task.requiredRole, blackboard, assignedWorkers);
      if (!idleWorker) continue;
      const claimRes = taskGraph.claimTask(task.taskId, idleWorker.agentId);
      if (!claimRes.ok) continue;
      const startRes = taskGraph.startTask(task.taskId);
      if (!startRes.ok) continue;
      assignedWorkers.add(idleWorker.agentId);
    }

    return { blackboard: blackboardToState(blackboard) };
  }

  /**
   * executeTask node (one per Send): run a single claimed task on its worker.
   * Each completion is a checkpoint boundary, so per-task progress survives
   * crashes. Failures are recorded via failTask so dependents/deadlock logic
   * can react.
   */
  async function executeTask(state: GraphState): Promise<Partial<GraphState>> {
    const { agentId, taskId } = state;
    const taskGraph = blackboard.getTaskGraph();
    if (!taskId || !agentId) {
      return { blackboard: blackboardToState(blackboard) };
    }

    const task = taskGraph.getTask(taskId);
    const worker = coordinator.findWorkerByAgentId(agentId);
    if (!task || !worker) {
      if (task) {
        taskGraph.failTask(taskId, `Worker ${agentId} unavailable`);
      }

      return { blackboard: blackboardToState(blackboard) };
    }

    try {
      await executeTaskWithWorker(task, worker, blackboard, coordinator.getOnActivity());
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

  debugLog('[SwarmCoordinator] Swarm stalled: deadlock or unresolved dependencies.');
  return END;
}

async function executeTaskWithWorker(
  task: Task,
  worker: AgentWorker,
  blackboard: Blackboard,
  onActivity?: SwarmCoordinatorRuntime['onActivity'],
): Promise<void> {
  const result = await worker.executeTask(task, (activity) => {
    onActivity?.(worker.role, activity);
  });
  blackboard.completeTask(task.taskId, result);
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
