/**
 * Agent Worker - Autonomous specialized worker with private OODA loop.
 */

import { type LanguageModel, type ModelMessage, type ToolSet } from 'ai';

import { streamWithContinuation } from '../session.js';
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
  maxOutputTokens?: number;
  maxToolSteps?: number;
  model: LanguageModel;
  modelTier?: ModelTier;
  role: AgentRole;
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
  private readonly maxOutputTokens: number;
  private readonly maxToolSteps: number;
  private readonly messages: ModelMessage[] = [];
  private readonly model: LanguageModel;
  private readonly systemPrompt: string;
  private readonly tools: ToolSet;

  constructor(options: AgentWorkerOptions) {
    this.agentId = options.agentId;
    this.role = options.role;
    this.model = options.model;
    this.blackboard = options.blackboard;
    this.modelTier = options.modelTier ?? 'standard';
    this.trustScore = options.trustScore ?? 0.7;
    this.evidenceTracker = new EvidenceTracker();
    const roleTools = createRoleToolSet(options.role, options.allTools);
    const blackboardTools = createBlackboardTools({
      agentId: this.agentId,
      blackboard: this.blackboard,
      evidenceTracker: this.evidenceTracker,
      modelTier: this.modelTier,
      trustScore: this.trustScore,
    });
    this.tools = { ...roleTools, ...blackboardTools };
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.maxToolSteps = options.maxToolSteps ?? 10;
    this.auditMode = options.auditMode ?? 'sast';
    this.diffScopeHint = options.diffScopeHint ?? '';

    
    this.systemPrompt = buildWorkerSystemPrompt(options.role, {
      auditMode: this.auditMode,
      diffScope: this.diffScopeHint,
      modelTier: this.modelTier,
    });

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
    onActivity?: (activity: { kind: string; message: string; toolName?: string }) => void,
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

    this.messages.push({
      content: userPrompt,
      role: 'user',
    });

    // Execute via streamWithContinuation
    const streamResult = await streamWithContinuation({
      maxOutputTokens: this.maxOutputTokens,
      maxToolSteps: this.maxToolSteps,
      messages: this.messages,
      model: this.model,
      onActivity: (activity) => {
        onActivity?.({
          kind: activity.kind,
          message: activity.summary,
          toolName: activity.toolName,
        });
        
        // Periodic heartbeat during tool calls
        this.blackboard.heartbeat(this.agentId, 'busy');
      },
      onChunk() {},
      systemPrompt: this.systemPrompt,
      tools: this.tools,
    });

    this.messages.push(...streamResult.messagesDelta);

    // Heartbeat back to idle
    this.blackboard.heartbeat(this.agentId, 'idle');

    return streamResult.text;
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
        console.error(`Error in cleanup callback for worker ${this.agentId}:`, error);
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
}
