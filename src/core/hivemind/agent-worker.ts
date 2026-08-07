/**
 * Agent Worker - Autonomous specialized worker with private OODA loop.
 */

import { type BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type BaseMessage } from '@langchain/core/messages';
import { type ToolSet } from 'ai';

import type { ShadowConfig } from '../../utils/config.js';
import type { MissionRuntimeObserver } from '../orchestrator/mission-runtime.js';
import type { NormalizedTokenUsage } from '../usage.js';

import { logToStderr } from '../../utils/stderr-logger.js';
import { DEFAULT_MAX_TOOL_STEPS } from '../model-capabilities.js';
import { type EnhancedFinding } from '../output/finding-schema.js';
import { executeLangChainToolLoop } from '../services/langchain-tool-executor.js';
import { effectiveAgentToolSteps } from '../services/tool-policy.js';
import { createBlackboardTools } from './blackboard-tools.js';
import { type Blackboard } from './blackboard.js';
import { EvidenceTracker } from './evidence-tracker.js';
import { type AgentRole, type ModelTier, type Task } from './hivemind-schema.js';
import { buildWorkerSystemPrompt } from './worker-prompts.js';
import { createRoleToolSet } from './worker-toolsets.js';

export interface AgentWorkerOptions {
  agentId: string;
  allTools: ToolSet;
  auditMode?: string;
  blackboard: Blackboard;
  diffScopeHint?: string;
  maxToolSteps?: number;
  missionRuntime?: MissionRuntimeObserver;
  model: BaseChatModel;
  modelTier?: ModelTier;
  onReportBatch?: (
    findings: Array<{ finding: EnhancedFinding; sourceClaimId: string }>,
  ) => { added: boolean; reason?: string };
  providerHint?: string;
  role: AgentRole;
  toolPolicy?: ShadowConfig['toolPolicy'];
  trustScore?: number;
}

/**
 * An autonomous agent worker representing a specialized role in the multi-agent swarm.
 */
export class AgentWorker {
  public readonly agentId: string;
  public readonly modelTier: ModelTier;
  public readonly role: AgentRole;
  public readonly trustScore: number;
  private readonly auditMode: string;
  private readonly blackboard: Blackboard;
  private readonly cleanupCallbacks: (() => void)[] = [];
  private readonly diffScopeHint: string;
  private readonly evidenceTracker: EvidenceTracker;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private isTerminated = false;
  private readonly maxContextMessages: number;
  private readonly maxToolSteps: number;
  private readonly messages: BaseMessage[] = [];
  private readonly missionRuntime?: MissionRuntimeObserver;
  private readonly model: BaseChatModel;
  private readonly onReportBatch?: AgentWorkerOptions['onReportBatch'];
  private readonly providerHint?: string;
  private readonly systemPrompt: string;
  private readonly tools: ToolSet;

  constructor(options: AgentWorkerOptions) {
    this.agentId = options.agentId;
    this.role = options.role;
    this.model = options.model;
    this.missionRuntime = options.missionRuntime;
    this.onReportBatch = options.onReportBatch;
    this.providerHint = options.providerHint;
    this.blackboard = options.blackboard;
    this.modelTier = options.modelTier ?? 'standard';
    this.trustScore = options.trustScore ?? 0.7;
    this.evidenceTracker = new EvidenceTracker();
    const roleTools = createRoleToolSet(options.role, options.allTools, options.toolPolicy);
    const blackboardTools = createBlackboardTools({
      agentId: this.agentId,
      blackboard: this.blackboard,
      evidenceTracker: this.evidenceTracker,
      modelTier: this.modelTier,
      trustScore: this.trustScore,
    });
    this.tools = {...roleTools, ...blackboardTools};
    this.maxToolSteps = effectiveAgentToolSteps(
      {toolPolicy: options.toolPolicy},
      options.role,
      options.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
    );
    this.maxContextMessages = 40; // cap to prevent unbounded growth across tasks
    this.auditMode = options.auditMode ?? 'sast';
    this.diffScopeHint = options.diffScopeHint ?? '';

    
    this.systemPrompt = buildWorkerSystemPrompt(options.role, {
      auditMode: this.auditMode,
      diffScope: this.diffScopeHint,
      modelTier: this.modelTier,
    });
    this.blackboard.heartbeat(this.agentId, 'idle');

    // Start periodic heartbeat to prevent timeouts during long tool runs.
    // `unref()` ensures the timer doesn't keep the Node.js event loop alive
    // if the worker is orphaned and terminate() is never called.
    this.heartbeatInterval = setInterval(() => {
      if (!this.isTerminated) {
        const agent = this.blackboard.getActiveAgents().find((a) => a.agentId === this.agentId);
        if (agent && agent.status !== 'offline') {
          this.blackboard.heartbeat(this.agentId, agent.status);
        }
      }
    }, 30_000).unref();
  }

  /**
   * Register a cleanup callback (e.g., unsubscribing from blackboard pub/sub).
   */
  addCleanupCallback(callback: () => void): void {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Run the worker OODA micro-loop on a claimed task.
   */
  async executeTask(
    task: Task,
    onActivity?: (activity: {
      args?: unknown;
      kind: string;
      message: string;
      result?: unknown;
      succeeded?: boolean;
      toolCallId?: string;
      toolName?: string;
      usage?: NormalizedTokenUsage;
    }) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.isTerminated) {
      throw new Error(`Worker ${this.agentId} is terminated.`);
    }

    // Heartbeat to Blackboard
    this.blackboard.heartbeat(this.agentId, 'busy');

    // Reset evidence tracking for this task.
    this.evidenceTracker.reset();
    this.extractEvidenceFromTask(task);

    const userPrompt = `### TASK TO EXECUTE:
Task ID: ${task.taskId}
Type: ${task.taskType}
Priority: ${task.priority}
Description: ${task.description}
Parameters: ${JSON.stringify(task.parameters, null, 2)}

Collaborate with the swarm. Inspect the blackboard if necessary, perform your task using your tools, and submit any relevant evidence/findings to the Blackboard. When you are fully done, call finish_task.`;

    try {
      const streamResult = await executeLangChainToolLoop({
        history: this.messages,
        maxToolSteps: this.maxToolSteps,
        missionRuntime: this.missionRuntime,
        model: this.model,
        onActivity: (activity) => {
          onActivity?.({
            args: activity.args,
            kind: activity.kind === 'tool' ? 'tool_call' : activity.kind,
            message: activity.summary,
            result: activity.result,
            succeeded: activity.succeeded,
            toolCallId: activity.toolCallId,
            toolName: activity.toolName,
            usage: activity.usage,
          });

          // Periodic heartbeat during tool calls
          this.blackboard.heartbeat(this.agentId, 'busy');
        },
        prompt: userPrompt,
        providerHint: this.providerHint,
        runtimeAgentId: this.agentId,
        runtimeExecutionId: Number(task.parameters._retryCount ?? 0) > 0
          ? `${task.taskId}:retry-${String(task.parameters._retryCount)}`
          : task.taskId,
        runtimeStage: `swarm_${this.role}`,
        signal,
        systemPrompt: this.systemPrompt,
        tools: this.tools,
      });

      const finishCalls = streamResult.toolCalls.filter((call) => call.name === 'finish_task');
      const successfulFinish = finishCalls.some((call) =>
        !(typeof call.result === 'string' && call.result.trimStart().startsWith('[ERROR]'))
      );
      if (!successfulFinish) {
        throw new Error(`Worker ${this.agentId} did not complete task ${task.taskId} with finish_task.`);
      }

      if (this.role === 'reporter' && task.taskType === 'report') {
        const acceptedClaimIds = this.blackboard.getAllClaims().filter((claim) =>
          (claim.status === 'verified' || claim.status === 'consensus') &&
          /vulnerab|finding/i.test(claim.claimType),
        ).map((claim) => claim.claimId);
        const reportCalls = streamResult.toolCalls.filter((call) => call.name === 'report_finding');
        const rejectedReports = reportCalls.filter((call) => {
          if (call.result && typeof call.result === 'object') {
            return (call.result as { accepted?: unknown }).accepted !== true;
          }

          if (typeof call.result !== 'string') return true;
          try {
            return (JSON.parse(call.result) as { accepted?: unknown }).accepted !== true;
          } catch {
            return true;
          }
        });
        const reportedClaimIds = reportCalls
          .filter((call) => !rejectedReports.includes(call))
          .map((call) => (call.args as { sourceClaimId?: unknown }).sourceClaimId)
          .filter((claimId): claimId is string => typeof claimId === 'string');
        const uniqueReportedClaimIds = new Set(reportedClaimIds);
        const missingClaimIds = acceptedClaimIds.filter((claimId) => !uniqueReportedClaimIds.has(claimId));
        const unknownClaimIds = [...uniqueReportedClaimIds].filter((claimId) => !acceptedClaimIds.includes(claimId));
        if (
          missingClaimIds.length > 0 ||
          unknownClaimIds.length > 0 ||
          reportedClaimIds.length !== uniqueReportedClaimIds.size ||
          rejectedReports.length > 0
        ) {
          throw new Error(
            'Reporter structured findings do not match accepted vulnerability claims. ' +
            `Missing: ${missingClaimIds.join(', ') || 'none'}; ` +
            `unknown: ${unknownClaimIds.join(', ') || 'none'}; ` +
            `duplicates: ${reportedClaimIds.length - uniqueReportedClaimIds.size}; ` +
            `rejected: ${rejectedReports.length}.`,
          );
        }

        if (this.onReportBatch) {
          const batch = reportCalls.map((call) => {
            const { sourceClaimId, ...finding } = call.args as EnhancedFinding & {
              sourceClaimId: string;
            };
            return { finding, sourceClaimId };
          });
          const commit = this.onReportBatch(batch);
          if (!commit.added) {
            throw new Error(
              `Reporter finding batch was rejected: ${commit.reason ?? 'unknown reason'}.`,
            );
          }
        }
      }

      this.messages.push(...streamResult.messagesDelta);
      this.trimMessages();
      return streamResult.text;
    } finally {
      if (!this.isTerminated) {
        this.blackboard.heartbeat(this.agentId, 'idle');
      }
    }
  }

  /**
   * Terminate the worker.
   */
  terminate(): void {
    this.isTerminated = true;

    // Run all cleanup callbacks to prevent memory leaks
    for (const cleanup of this.cleanupCallbacks) {
      try {
        cleanup();
      } catch (error) {
        logToStderr(`Error in cleanup callback for worker ${this.agentId}: ${String(error)}`);
      }
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.blackboard.heartbeat(this.agentId, 'offline');
  }

  /**
   * Extract canonical IDs from task parameters and record them as evidence.
   */
  private extractEvidenceFromTask(task: Task): void {
    const scan = (value: unknown): void => {
      if (typeof value === 'string') {
        // Match canonical IDs like ent_abc123, claim_..., task_...
        const matches = value.match(/\b[a-z]+_[a-f0-9]{8,64}\b/g);
        if (matches) {
          this.evidenceTracker.addEntities(matches);
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          scan(item);
        }
      } else if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) {
          scan(nested);
        }
      }
    };

    scan(task.parameters);
  }

  /**
   * Trim message history to prevent unbounded growth across multiple
   * task executions without separating an assistant tool call from its
   * corresponding tool results.
   */
  private trimMessages(): void {
    const max = this.maxContextMessages;
    if (this.messages.length <= max) return;
    const groups: BaseMessage[][] = [];
    for (const message of this.messages) {
      const previous = groups.at(-1);
      if (
        message._getType() === 'tool' &&
        previous?.some((entry) =>
          entry._getType() === 'ai' &&
          Array.isArray((entry as {tool_calls?: unknown[]}).tool_calls) &&
          (entry as {tool_calls?: unknown[]}).tool_calls!.length > 0
        )
      ) {
        previous.push(message);
      } else {
        groups.push([message]);
      }
    }

    const retained: BaseMessage[][] = [];
    let retainedCount = 0;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index]!;
      if (retained.length > 0 && retainedCount + group.length > max) break;
      retained.unshift(group);
      retainedCount += group.length;
    }

    this.messages.length = 0;
    this.messages.push(...retained.flat());
  }
}
