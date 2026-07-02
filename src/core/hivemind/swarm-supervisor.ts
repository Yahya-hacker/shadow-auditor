/**
 * Swarm Supervisor - LangGraph-native orchestration of the multi-agent swarm.
 *
 * Replaces the imperative while(true) coordinator loop with a checkpointed
 * StateGraph. The supervisor state is the AgentState blackboard channel, so
 * blackboard snapshots survive process restarts through PersistentCheckpointSaver.
 */

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { END, START, StateGraph } from '@langchain/langgraph';

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

 
interface RunningTask {
  promise: Promise<void>;
  taskId: string;
  workerAgentId: string;
}

// Maximum time a task can remain in_progress before the supervisor resets it.
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Build the LangGraph supervisor that drives the swarm.
 *
 * The graph owns the lifecycle of the mission: plan, spawn, dispatch, collect,
 * and cleanup. Runtime handles (workers, promises) are held outside the graph
 * in the SwarmCoordinator; only the serializable blackboard state crosses the
 * checkpoint boundary.
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
    // Idempotent: if agents already exist, do not re-spawn.
    if (blackboard.getActiveAgents().length > 0) {
      return { blackboard: blackboardToState(blackboard) };
    }

    const rolesToSpawn: AgentRole[] = ['recon', 'taint-tracer', 'exploit-analyst', 'verifier', 'reporter'];
    if (coordinator.isPatchEnabled()) {
      rolesToSpawn.push('patch-engineer');
    }

    for (const role of rolesToSpawn) {
      const regRes = blackboard.registerAgent(role, ['typescript', 'security']);
      if (!regRes.ok) throw new Error(regRes.error);
      const agentId = regRes.value.agentId;

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

    return { blackboard: blackboardToState(blackboard) };
  }

  async function supervise(): Promise<Partial<GraphState>> {
    const taskGraph = blackboard.getTaskGraph();
    const activeAgents = blackboard.getActiveAgents();

    // Reset stale in-progress tasks: those whose assigned agents have gone
    // offline, or those that have been running too long. This makes the
    // supervisor resilient to process restarts, where in-memory promises were
    // lost but the blackboard still shows tasks as in_progress.
    for (const task of taskGraph.getTasksByStatus('in_progress')) {
      const agent = activeAgents.find((a) => a.agentId === task.assignedAgent);
      const runningTooLong =
        task.updatedAt && Date.now() - new Date(task.updatedAt).getTime() > STALE_IN_PROGRESS_MS;
      if (!agent || agent.status === 'offline' || runningTooLong) {
        taskGraph.releaseTask(task.taskId);
      }
    }

    const claimable = taskGraph.getClaimableTasks();
    const dispatched: RunningTask[] = [];
    const assignedWorkers = new Set<string>();

    for (const task of claimable) {
      if (!task.requiredRole) continue;

      const idleWorker = coordinator.findIdleWorker(task.requiredRole, blackboard, assignedWorkers);
      if (!idleWorker) continue;

      const claimRes = taskGraph.claimTask(task.taskId, idleWorker.agentId);
      if (!claimRes.ok) continue;

      const startRes = taskGraph.startTask(task.taskId);
      if (!startRes.ok) continue;

      assignedWorkers.add(idleWorker.agentId);

      const promise = executeTaskWithWorker(task, idleWorker, blackboard, coordinator.getOnActivity()).catch(
        (error) => {
          process.stderr.write(`[SwarmCoordinator] Task ${task.taskId} failed: ${error}\n`);
          taskGraph.failTask(task.taskId, error instanceof Error ? error.message : String(error));
        },
      );

      dispatched.push({ promise, taskId: task.taskId, workerAgentId: idleWorker.agentId });
    }

    if (dispatched.length > 0) {
      // Wait for the current batch to finish before checkpointing again. The
      // blackboard state itself is checkpointed after every supervise step.
      await Promise.all(dispatched.map((d) => d.promise));
    } else {
      // No work available yet; yield briefly to avoid busy-spinning.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
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

  function routeAfterSupervise(state: GraphState): string {
    const bb = state.blackboard;
    const allTasks = bb.tasks;
    const isFinished = allTasks.every(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );
    if (isFinished) {
      return 'cleanup';
    }

    const stalled =
      allTasks.every((t) => t.status !== 'in_progress') &&
      allTasks.some((t) => t.status === 'blocked' || t.status === 'pending');

    if (stalled) {
      process.stderr.write('[SwarmCoordinator] Swarm stalled. Deadlock or dependency issues.\n');
      return END;
    }

    return 'supervise';
  }

  const workflow = new StateGraph(AgentState)
    .addNode('planMission', planMission)
    .addNode('spawnWorkers', spawnWorkers)
    .addNode('supervise', supervise)
    .addNode('cleanup', cleanup)
    .addEdge(START, 'planMission')
    .addEdge('planMission', 'spawnWorkers')
    .addEdge('spawnWorkers', 'supervise')
    .addConditionalEdges('supervise', routeAfterSupervise)
    .addEdge('cleanup', END);

  return workflow.compile({ checkpointer });
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
    consensusRecords: [],
    runId: blackboard.getRunId(),
    schemaVersion: '1.0.0',
    snapshotAt: new Date().toISOString(),
    tasks: taskGraph.getAllTasks(),
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
  getConfig: () => SwarmCoordinatorOptions['config'];
  getModel: () => SwarmCoordinatorOptions['model'];
  getOnActivity: () => SwarmCoordinatorRuntime['onActivity'] | undefined;
  getUserMessage: () => string;
  isPatchEnabled: () => boolean;
  onActivity?: (
    workerRole: AgentRole,
    activity: { kind: string; message: string; toolName?: string },
  ) => void;
  registerWorker: (agentId: string, worker: AgentWorker) => void;
  terminateAllWorkers: () => void;
}
