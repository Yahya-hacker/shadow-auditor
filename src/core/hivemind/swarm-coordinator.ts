/**
 * Swarm Coordinator - Parallel multi-agent task and execution manager.
 */

import { type LanguageModel, type ToolSet } from 'ai';

import { type ShadowConfig } from '../../utils/config.js';
import { AgentWorker } from './agent-worker.js';
import { Blackboard } from './blackboard.js';
import { type AgentRole } from './hivemind-schema.js';

export interface SwarmCoordinatorOptions {
  allTools: ToolSet;
  auditMode?: string;
  config: ShadowConfig;
  diffScopeHint?: string;
  model: LanguageModel;
  runId: string;
  storagePath: string;
}

/**
 * Manages swarm orchestration, task dependency decomposition, parallel execution, and consensus flow.
 */
export class SwarmCoordinator {
  private readonly allTools: ToolSet;
  private readonly auditMode: string;
  private blackboard!: Blackboard;
  private readonly config: ShadowConfig;
  private readonly diffScopeHint: string;
  private readonly model: LanguageModel;
  private readonly runId: string;
  private readonly storagePath: string;
  private readonly workers: Map<string, AgentWorker> = new Map();

  constructor(options: SwarmCoordinatorOptions) {
    this.config = options.config;
    this.model = options.model;
    this.allTools = options.allTools;
    this.storagePath = options.storagePath;
    this.runId = options.runId;
    this.auditMode = options.auditMode ?? 'sast';
    this.diffScopeHint = options.diffScopeHint ?? '';
  }

  async executeMission(
    userMessage: string,
    onActivity?: (
      workerRole: AgentRole,
      activity: { kind: string; message: string; toolName?: string },
    ) => void,
  ): Promise<string> {
    // 1. Initialize Blackboard
    this.blackboard = await Blackboard.create({
      heartbeatTimeout: 60_000,
      runId: this.runId,
      storagePath: this.storagePath,
    });

    const taskGraph = this.blackboard.getTaskGraph();

    // 2. Decompose user mission into Tasks
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

    const patchEnabled = this.config.swarm?.roles?.includes('patch-engineer') ?? false;
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
    const reportTaskId = reportRes.value.taskId;

    // 3. Spawn workers
    const rolesToSpawn: AgentRole[] = ['recon', 'taint-tracer', 'exploit-analyst', 'verifier', 'reporter'];
    if (patchEnabled) {
      rolesToSpawn.push('patch-engineer');
    }

    for (const role of rolesToSpawn) {
      const regRes = this.blackboard.registerAgent(role, ['typescript', 'security']);
      if (!regRes.ok) throw new Error(regRes.error);
      const agentId = regRes.value.agentId;

      const worker = new AgentWorker({
        agentId,
        allTools: this.allTools,
        auditMode: this.auditMode,
        blackboard: this.blackboard,
        diffScopeHint: this.diffScopeHint,
        maxOutputTokens: 4096,
        maxToolSteps: 10,
        model: this.model,
        role,
      });

      this.workers.set(agentId, worker);
    }

    // 4. Run Execution Loop
    let reporterOutput = '';
    const activeTasks: Map<string, Promise<void>> = new Map();

    while (true) {
      const allTasks = taskGraph.getAllTasks();

      const isFinished = allTasks.every(
        (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
      );
      if (isFinished) {
        break;
      }

      // Check for any blocked tasks that became unblocked
      const claimable = taskGraph.getClaimableTasks();
      for (const task of claimable) {
        if (!task.requiredRole) continue;
        if (activeTasks.has(task.taskId)) continue;

        // Find an idle agent worker with the matching role
        const idleWorker = [...this.workers.values()].find(
          (w) =>
            w.role === task.requiredRole &&
            this.blackboard.getActiveAgents().find((a) => a.agentId === w.agentId)?.status === 'idle',
        );

        if (idleWorker) {
          // Claim the task
          const claimRes = taskGraph.claimTask(task.taskId, idleWorker.agentId);
          if (claimRes.ok) {
            const startRes = taskGraph.startTask(task.taskId);
            if (startRes.ok) {
              const promise = (async () => {
                try {
                  const result = await idleWorker.executeTask(startRes.value, (act) => {
                    onActivity?.(idleWorker.role, act);
                  });
                  this.blackboard.completeTask(task.taskId, result);
                  if (task.taskId === reportTaskId) {
                    reporterOutput = result;
                  }
                } catch (error) {
                  console.error(`Task ${task.taskId} failed:`, error);
                  taskGraph.failTask(task.taskId, error instanceof Error ? error.message : String(error));
                } finally {
                  activeTasks.delete(task.taskId);
                }
              })();
              activeTasks.set(task.taskId, promise);
            }
          }
        }
      }

      // If no tasks are running and there are no claimable tasks, break.
      if (activeTasks.size === 0 && claimable.length === 0) {
        const hasUnfinished = allTasks.some((t) => t.status === 'blocked' || t.status === 'pending');
        if (hasUnfinished) {
          console.warn('[SwarmCoordinator] Swarm stalled. Deadlock or dependency issues.');
          break;
        }

        break;
      }

      // Save Blackboard snapshot
      await this.blackboard.saveSnapshot();

      // Wait a bit
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    // 5. Cleanup workers
    for (const worker of this.workers.values()) {
      worker.terminate();
    }

    // Save final blackboard snapshot
    await this.blackboard.saveSnapshot();

    return reporterOutput || 'No report generated by reporting worker.';
  }

  getBlackboard(): Blackboard {
    return this.blackboard;
  }
}
