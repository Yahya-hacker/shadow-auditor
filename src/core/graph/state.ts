import { BaseMessage } from '@langchain/core/messages';
import { BaseStore } from '@langchain/core/stores';
import { Annotation } from '@langchain/langgraph';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  AdversarialVerdict,
  AuditStage,
  CodebaseIntelligenceArtifact,
  DevilsAdvocateArtifact,
  SastAuditArtifact,
} from './pipeline-artifacts.js';

import { recoverAtomicWrite, writeFileAtomic } from '../../utils/fs-atomic.js';
import { type BlackboardState } from '../hivemind/hivemind-schema.js';
import { type EnhancedFinding } from '../output/finding-schema.js';

/** Sliding window: maximum messages to keep in context. */
export const MAX_CONTEXT_MESSAGES = 40;

type KnowledgeGraphState = Record<string, unknown>;
type MemoryEntry = Record<string, unknown>;
type StoreValue = Record<string, unknown>;

function toolCallIds(message: BaseMessage): string[] {
  const calls = (message as BaseMessage & {
    tool_calls?: Array<{id?: string}>;
  }).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => call.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function toolResultId(message: BaseMessage): null | string {
  const id = (message as BaseMessage & {tool_call_id?: unknown}).tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Keeps a bounded suffix without splitting assistant tool-call transactions.
 * A single large multi-tool transaction may intentionally exceed the limit.
 */
export function trimContextMessages(
  messages: BaseMessage[],
  limit = MAX_CONTEXT_MESSAGES,
): BaseMessage[] {
  if (messages.length <= limit || limit < 2) return messages;

  const first = messages[0]!;
  let tailStart = messages.length - (limit - 1);

  // A result in the retained suffix requires its owning assistant request.
  // Re-evaluate after expansion because the larger suffix may expose another
  // transaction boundary.
  let changed = true;
  while (changed) {
    changed = false;
    const parentByCallId = new Map<string, number>();
    for (const [index, message] of messages.entries()) {
      for (const id of toolCallIds(message)) {
        parentByCallId.set(id, index);
      }
    }

    for (let index = tailStart; index < messages.length; index++) {
      const resultId = toolResultId(messages[index]!);
      if (!resultId) continue;
      const parentIndex = parentByCallId.get(resultId);
      if (parentIndex !== undefined && parentIndex > 0 && parentIndex < tailStart) {
        tailStart = parentIndex;
        changed = true;
      }
    }
  }

  const recent = messages.slice(tailStart);
  const retainedCallIds = new Set([
    ...recent.flatMap((message) => toolCallIds(message)),
    ...toolCallIds(first),
  ]);
  const coherentRecent = recent.filter((message) => {
    const resultId = toolResultId(message);
    return resultId === null || retainedCallIds.has(resultId);
  });

  return tailStart === 0 ? coherentRecent : [first, ...coherentRecent];
}

/**
 * Human-input request carried across the LangGraph checkpoint boundary.
 * When a tool needs confirmation or a question answered, it sets this field
 * via a Command and routes the graph to the HumanIntervention node (which
 * is declared as an interruptBefore point). The graph pauses, the TUI shows
 * the question, and when the user responds the graph is resumed with the
 * answer injected as a HumanMessage and this field cleared to null.
 */
export interface HumanInputRequest {
  context?: string;
  question: string;
  requestId?: string;
  type: 'confirmation' | 'question';
}

function mergeBlackboard(
  left: BlackboardState,
  right: Partial<BlackboardState>,
): BlackboardState {
  return {
    agents: right.agents ?? left.agents,
    claims: mergeById(left.claims, right.claims ?? [], 'claimId'),
    conflicts: mergeById(left.conflicts, right.conflicts ?? [], 'conflictId'),
    consensusRecords: right.consensusRecords ?? left.consensusRecords,
    runId: right.runId ?? left.runId,
    schemaVersion: right.schemaVersion ?? left.schemaVersion,
    snapshotAt: right.snapshotAt ?? left.snapshotAt,
    tasks: mergeById(left.tasks, right.tasks ?? [], 'taskId'),
  };
}

function mergeById<T extends Record<string, unknown>>(
  existing: T[],
  update: T[],
  idKey: keyof T,
): T[] {
  const map = new Map<string, T>();
  for (const item of existing) {
    map.set(String(item[idKey]), item);
  }

  for (const item of update) {
    map.set(String(item[idKey]), item);
  }

  return [...map.values()];
}

/* eslint-disable new-cap */
export const AgentState = Annotation.Root({
  activeStage: Annotation<AuditStage>({
    default: () => 'codebase_intelligence',
    reducer: (_state, update) => update,
  }),
  agentId: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  // Audited files: authoritative list of files already examined by SAST.
  // Survives context trimming — unlike the old regex-based extraction from
  // message text which was fragile against LLM formatting variations.
  auditedFiles: Annotation<string[]>({
    default: () => [],
    reducer: (_state, update) => [...new Set(update)],
  }),
  auditRunId: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  blackboard: Annotation<BlackboardState>({
    default: () => ({
      agents: [],
      claims: [],
      conflicts: [],
      consensusRecords: [],
      runId: '',
      schemaVersion: '1.0.0',
      snapshotAt: new Date().toISOString(),
      tasks: [],
    }),
    reducer: (state, update) => (update ? mergeBlackboard(state, update) : state),
  }),
  codebaseIntelligence: Annotation<CodebaseIntelligenceArtifact | null>({
    default: () => null,
    reducer: (_state, update) => update,
  }),
  devilsAdvocate: Annotation<DevilsAdvocateArtifact | null>({
    default: () => null,
    reducer: (_state, update) => update,
  }),
  // Discovered findings: structured records of vulnerabilities found during
  // analysis. Preserved across context compression so the agent never
  // "forgets" its discoveries.
  discoveredFindings: Annotation<string[]>({
    default: () => [],
    reducer: (_state, update) => [...new Set(update)],
  }),
  evidenceActions: Annotation<number>({
    default: () => 0,
    reducer: (_state, update) => update,
  }),
  findings: Annotation<EnhancedFinding[]>({
    default: () => [],
    reducer: (state, update) => mergeById(state, update, 'vulnId'),
  }),
  iterationCount: Annotation<number>({
    default: () => 0,
    reducer: (_state, update) => update,
  }),
  knowledgeGraph: Annotation<KnowledgeGraphState>({
    default: () => ({}),
    reducer: (state, update) => ({ ...state, ...update }),
  }),
  // Tracks which specialist last invoked the model (set by specialist nodes).
  // Used by routeFromToolExecutor to return directly to the initiating
  // specialist instead of always routing through Supervisor, saving an
  // unnecessary LLM round-trip per tool call.
  lastSpecialist: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  longTermMemory: Annotation<MemoryEntry[]>({
    default: () => [],
    reducer: (state, update) => state.concat(update),
  }),
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    // Custom reducer: enforces MAX_CONTEXT_MESSAGES so the full message
    // array doesn't grow unbounded. Keeps the first message (system context
    // or user query) + the most recent N-1 messages, but ensures tool
    // call/result pairs are never split — orphaned ToolMessages cause a
    // "400 Messages with role 'tool' must be a response to a preceding
    // message with 'tool_calls'" error from OpenAI-compatible providers.
    reducer(state, update) {
      const replacement = update[0] as BaseMessage | undefined;
      if (
        replacement &&
        (replacement.additional_kwargs as Record<string, unknown> | undefined)
          ?.shadowCompactReplace === true
      ) {
        return update;
      }

      const merged = state.concat(update);
      if (merged.length <= MAX_CONTEXT_MESSAGES) return merged;

      return trimContextMessages(merged);
    },
  }),
  mission: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  // Supervisor routing: the next node to execute, set by the Supervisor's
  // structured output. Drives intelligent multi-agent delegation (vs the
  // old static fallback that always routed to SastAnalyzer). Cleared after
  // each routing decision is consumed.
  nextNode: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  // Human-input request: when a tool needs confirmation or a question, it
  // sets this field via a Command throw and routes to HumanIntervention. The
  // graph pauses at interruptBefore, the TUI shows the question, and the
  // resume call clears this to null.
  pendingHumanInput: Annotation<HumanInputRequest | null>({
    default: () => null,
    reducer: (_state, update) => update,
  }),
  pipelineFindings: Annotation<EnhancedFinding[]>({
    default: () => [],
    reducer: (_state, update) => update,
  }),
  pipelineReport: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  reflectorRetryCount: Annotation<number>({
    default: () => 0,
    reducer: (_state, update) => update,
  }),
  reflectorVerdict: Annotation<'PASS' | 'RETRY' | 'UNCLEAR'>({
    default: () => 'UNCLEAR',
    reducer: (_state, update) => update,
  }),
  sastAudit: Annotation<null | SastAuditArtifact>({
    default: () => null,
    reducer: (_state, update) => update,
  }),
  stageIterations: Annotation<Record<AuditStage, number>>({
    default: () => ({
      codebase_intelligence: 0,
      devils_advocate: 0,
      reporting: 0,
      sast_audit: 0,
    }),
    reducer: (_state, update) => update,
  }),
  // Transient per-task routing fields populated by Send() fan-out from the
  // swarm supervisor's `dispatch` conditional edge. Each parallel
  // `executeTask` node instance receives the (taskId, agentId) pair it should
  // run. They are not meaningful across supersteps and are undefined on the
  // main agent workflow graph.
  taskId: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  verdicts: Annotation<AdversarialVerdict[]>({
    default: () => [],
    reducer: (_state, update) => update,
  }),
  // Working memory: a compact, running summary of analysis progress, key
  // findings, current hypotheses, and files already examined. Updated after
  // significant discoveries and injected into the system prompt so the model
  // always has immediate access to the current state without re-reading the
  // full conversation history. This is critical for long-running sessions
  // where the message buffer gets trimmed.
  workingMemory: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
});
/* eslint-enable new-cap */

export type AgentStateType = typeof AgentState.State;

export class ProjectPersistentStore extends BaseStore<string, StoreValue> {
  lc_namespace = ['langgraph', 'store'];
  private initialization?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly storePath: string;

  constructor(projectRoot: string) {
    super();
    this.storePath = path.join(projectRoot, '.shadow-auditor', 'long-term-memory.json');
  }

  async mdelete(keys: string[]): Promise<void> {
    await this.mutateStore((store) => {
      for (const key of keys) delete store[key];
    });
  }

  async mget(keys: string[]): Promise<Array<StoreValue | undefined>> {
    const store = await this.readStore();
    return keys.map((key) => store[key]);
  }

  async mset(keyValuePairs: Array<[string, StoreValue]>): Promise<void> {
    await this.mutateStore((store) => {
      for (const [key, value] of keyValuePairs) store[key] = value;
    });
  }

  async *yieldKeys(prefix?: string): AsyncGenerator<string> {
    const store = await this.readStore();
    for (const key of Object.keys(store)) {
      if (prefix === undefined || key.startsWith(prefix)) {
        yield key;
      }
    }
  }

  private async ensureStoreExists(): Promise<void> {
    if (this.initialization) return this.initialization;
    const initialization = this.initializeStore();
    this.initialization = initialization;
    try {
      await initialization;
    } catch (error) {
      if (this.initialization === initialization) this.initialization = undefined;
      throw error;
    }
  }

  private async initializeStore(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await recoverAtomicWrite(this.storePath);
    try {
      await fs.access(this.storePath);
    } catch {
      await writeFileAtomic(this.storePath, JSON.stringify({}, null, 2));
    }
  }

  private async mutateStore(mutator: (store: Record<string, StoreValue>) => void): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      const store = await this.readStore();
      mutator(store);
      await this.writeStore(store);
    });
    this.mutationQueue = operation.catch(() => {});
    await operation;
  }

  private async readStore(): Promise<Record<string, StoreValue>> {
    await this.ensureStoreExists();
    try {
      await recoverAtomicWrite(this.storePath);
      const data = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(data) as Record<string, StoreValue>;
      // Prototype pollution guard: strip __proto__, constructor, prototype keys
      return sanitizeParsedJson(parsed);
    } catch (error) {
      process.stderr.write(`[ShadowAuditor] Failed to read store at ${this.storePath}: ${error}\n`);
      return {};
    }
  }

  private async writeStore(data: Record<string, StoreValue>): Promise<void> {
    await this.ensureStoreExists();
    try {
      await writeFileAtomic(this.storePath, JSON.stringify(data, null, 2));
    } catch (error) {
      process.stderr.write(`[ShadowAuditor] Failed to write store at ${this.storePath}: ${error}\n`);
    }
  }
}

/**
 * Strip prototype-pollution keys from parsed JSON objects.
 * Object.create(null) prevents __proto__ accessor from being inherited.
 */
function sanitizeParsedJson<T extends Record<string, unknown>>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  const cleaned = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    cleaned[key] = value;
  }

  return cleaned as T;
}
