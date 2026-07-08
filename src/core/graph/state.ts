import { BaseMessage } from '@langchain/core/messages';
import { BaseStore } from '@langchain/core/stores';
import { Annotation } from '@langchain/langgraph';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type BlackboardState } from '../hivemind/hivemind-schema.js';
import { type EnhancedFinding } from '../output/finding-schema.js';

type KnowledgeGraphState = Record<string, unknown>;
type MemoryEntry = Record<string, unknown>;
type StoreValue = Record<string, unknown>;

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
  agentId: Annotation<string>({
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
  findings: Annotation<EnhancedFinding[]>({
    default: () => [],
    reducer: (state, update) => state.concat(update),
  }),
  iterationCount: Annotation<number>({
    default: () => 0,
    reducer: (_state, update) => update,
  }),
  knowledgeGraph: Annotation<KnowledgeGraphState>({
    default: () => ({}),
    reducer: (state, update) => ({ ...state, ...update }),
  }),
  longTermMemory: Annotation<MemoryEntry[]>({
    default: () => [],
    reducer: (state, update) => state.concat(update),
  }),
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    // Custom reducer: enforces MAX_CONTEXT_MESSAGES so the full message
    // array doesn't grow unbounded. Keeps the first message (system context
    // or user query) + the most recent N-1 messages. This prevents checkpoint
    // bloat and ensures the LLM always sees a manageable context window.
    reducer: (state, update) => {
      const MAX_CONTEXT_MESSAGES = 40;
      const merged = state.concat(update);
      if (merged.length <= MAX_CONTEXT_MESSAGES) return merged;
      // Keep first message (context anchor) + last N-1 messages
      const first = merged[0]!;
      const recent = merged.slice(-(MAX_CONTEXT_MESSAGES - 1));
      return [first, ...recent];
    },
  }),
  // Human-input request: when a tool needs confirmation or a question, it
  // sets this field via a Command throw and routes to HumanIntervention. The
  // graph pauses at interruptBefore, the TUI shows the question, and the
  // resume call clears this to null.
  pendingHumanInput: Annotation<HumanInputRequest | null>({
    default: () => null,
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
  // Supervisor routing: the next node to execute, set by the Supervisor's
  // structured output. Drives intelligent multi-agent delegation (vs the
  // old static fallback that always routed to SastAnalyzer). Cleared after
  // each routing decision is consumed.
  nextNode: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  // Tracks which specialist last invoked the model (set by specialist nodes).
  // Used by routeFromToolExecutor to return directly to the initiating
  // specialist instead of always routing through Supervisor, saving an
  // unnecessary LLM round-trip per tool call.
  lastSpecialist: Annotation<string>({
    default: () => '',
    reducer: (_state, update) => update,
  }),
  // Audited files: authoritative list of files already examined by SAST.
  // Survives context trimming — unlike the old regex-based extraction from
  // message text which was fragile against LLM formatting variations.
  auditedFiles: Annotation<string[]>({
    default: () => [],
    reducer: (state, update) => [...new Set([...state, ...update])],
  }),
  // Discovered findings: structured records of vulnerabilities found during
  // analysis. Preserved across context compression so the agent never
  // "forgets" its discoveries.
  discoveredFindings: Annotation<string[]>({
    default: () => [],
    reducer: (state, update) => [...new Set([...state, ...update])],
  }),
});
/* eslint-enable new-cap */

export type AgentStateType = typeof AgentState.State;

export class ProjectPersistentStore extends BaseStore<string, StoreValue> {
  lc_namespace = ['langgraph', 'store'];
  private readonly storePath: string;

  constructor(projectRoot: string) {
    super();
    this.storePath = path.join(projectRoot, '.shadow-auditor', 'long-term-memory.json');
    this.ensureStoreExists();
  }

  async mdelete(keys: string[]): Promise<void> {
    const store = this.readStore();
    for (const key of keys) {
      delete store[key];
    }

    this.writeStore(store);
  }

  async mget(keys: string[]): Promise<Array<StoreValue | undefined>> {
    const store = this.readStore();
    return keys.map((key) => store[key]);
  }

  async mset(keyValuePairs: Array<[string, StoreValue]>): Promise<void> {
    const store = this.readStore();
    for (const [key, value] of keyValuePairs) {
      store[key] = value;
    }

    this.writeStore(store);
  }

  async *yieldKeys(prefix?: string): AsyncGenerator<string> {
    const store = this.readStore();
    for (const key of Object.keys(store)) {
      if (prefix === undefined || key.startsWith(prefix)) {
        yield key;
      }
    }
  }

  private ensureStoreExists(): void {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.storePath)) {
      fs.writeFileSync(this.storePath, JSON.stringify({}, null, 2), 'utf8');
    }
  }

  private readStore(): Record<string, StoreValue> {
    try {
      const data = fs.readFileSync(this.storePath, 'utf8');
      return JSON.parse(data) as Record<string, StoreValue>;
    } catch (error) {
      process.stderr.write(`[ShadowAuditor] Failed to read store at ${this.storePath}: ${error}\n`);
      return {};
    }
  }

  private writeStore(data: Record<string, StoreValue>): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      process.stderr.write(`[ShadowAuditor] Failed to write store at ${this.storePath}: ${error}\n`);
    }
  }
}
