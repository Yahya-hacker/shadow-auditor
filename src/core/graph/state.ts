import { BaseMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, MemorySaver } from '@langchain/langgraph';
import { EnhancedFinding } from '../output/finding-schema.js';
import { BaseStore } from '@langchain/core/stores';
import * as fs from 'fs';
import * as path from 'path';

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (state, update) => state.concat(update),
    default: () => [],
  }),
  findings: Annotation<EnhancedFinding[]>({
    reducer: (state, update) => state.concat(update),
    default: () => [],
  }),
  knowledgeGraph: Annotation<Record<string, any>>({
    reducer: (state, update) => ({ ...state, ...update }),
    default: () => ({}),
  }),
  longTermMemory: Annotation<any[]>({
    reducer: (state, update) => state.concat(update),
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentState.State;

export class ProjectPersistentStore extends BaseStore<string, any> {
  lc_namespace = ["langgraph", "store"];
  private readonly storePath: string;

  constructor(projectRoot: string) {
    super();
    this.storePath = path.join(projectRoot, '.shadow-auditor', 'long-term-memory.json');
    this.ensureStoreExists();
  }

  private ensureStoreExists(): void {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.storePath)) {
      fs.writeFileSync(this.storePath, JSON.stringify({}), 'utf-8');
    }
  }

  private readStore(): Record<string, any> {
    try {
      const data = fs.readFileSync(this.storePath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`Failed to read store at ${this.storePath}:`, error);
      return {};
    }
  }

  private writeStore(data: Record<string, any>): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error(`Failed to write store at ${this.storePath}:`, error);
    }
  }

  async mget(keys: string[]): Promise<(any | undefined)[]> {
    const store = this.readStore();
    return keys.map((key) => store[key]);
  }

  async mset(keyValuePairs: [string, any][]): Promise<void> {
    const store = this.readStore();
    for (const [key, value] of keyValuePairs) {
      store[key] = value;
    }
    this.writeStore(store);
  }

  async mdelete(keys: string[]): Promise<void> {
    const store = this.readStore();
    for (const key of keys) {
      delete store[key];
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
}
