import { BaseMessage } from '@langchain/core/messages';
import { BaseStore } from '@langchain/core/stores';
import { Annotation } from '@langchain/langgraph';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type EnhancedFinding } from '../output/finding-schema.js';

type KnowledgeGraphState = Record<string, unknown>;
type MemoryEntry = Record<string, unknown>;
type StoreValue = Record<string, unknown>;

/* eslint-disable new-cap */
export const AgentState = Annotation.Root({
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
    reducer: (state, update) => state.concat(update),
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
