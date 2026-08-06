/**
 * PersistentCheckpointSaver - LangGraph checkpointer backed by the filesystem.
 *
 * Replaces the in-memory MemorySaver so that agent state survives process
 * restarts. Checkpoints are stored as JSON under
 * <storagePath>/langgraph-checkpoints/<threadId>/<checkpointId>.json.
 */

import type { RunnableConfig } from '@langchain/core/runnables';

import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { recoverAtomicWrite, writeFileAtomic } from '../../utils/fs-atomic.js';
import {
  defaultTrustPath,
  loadOrCreateHostKey,
  signHostData,
  verifyHostData,
} from '../../utils/host-trust.js';

const NOOP = () => {};

interface StoredCheckpoint {
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  parentConfig?: RunnableConfig;
  pendingWrites: CheckpointPendingWrite[];
}

interface SerializedCheckpoint {
  data: string;
  signature: string;
  type: string;
  version: 2;
}

interface ThreadIndex {
  checkpointId: string;
  timestamp: string;
}

export interface PersistentCheckpointSaverOptions {
  integrityKeyPath?: string;
  maxCheckpointsPerThread?: number;
  storagePath: string;
}

export class PersistentCheckpointSaver extends BaseCheckpointSaver {
  private readonly checkpointsDir: string;
  private integrityKey?: Buffer;
  private readonly integrityKeyPath: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly maxCheckpointsPerThread: number;

  constructor(options: PersistentCheckpointSaverOptions) {
    super();
    this.checkpointsDir = path.join(options.storagePath, 'langgraph-checkpoints');
    this.integrityKeyPath = options.integrityKeyPath
      ?? defaultTrustPath('checkpoint-integrity.key');
    this.maxCheckpointsPerThread = options.maxCheckpointsPerThread ?? 100;
    if (!Number.isInteger(this.maxCheckpointsPerThread) || this.maxCheckpointsPerThread < 1) {
      throw new Error('maxCheckpointsPerThread must be a positive integer.');
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const threadDir = this.threadPath(threadId);
    await fs.rm(threadDir, { force: true, recursive: true });
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const checkpointId = this.getCheckpointId(config);
    const threadId = this.getThreadId(config);
    if (!checkpointId) {
      // The checkpoint file is durable before latest.json is updated. Always
      // reconcile from checkpoint files so a crash cannot hide newer state.
      const latest = await this.list(config, { limit: 1 }).next();

      return latest.value;
    }

    const filePath = this.checkpointPath(threadId, checkpointId);

    try {
      const stored = await this.readCheckpoint(filePath);

      return {
        checkpoint: stored.checkpoint,
        config: {
          configurable: {
            checkpoint_id: stored.checkpoint.id,
            thread_id: threadId,
          },
        },
        metadata: stored.metadata,
        parentConfig: stored.parentConfig,
        pendingWrites: stored.pendingWrites,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.checkpointsDir, { recursive: true }),
      loadOrCreateHostKey(this.integrityKeyPath).then((key) => {
        this.integrityKey = key;
      }),
    ]);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const threadId = this.getThreadId(config);
    const threadDir = this.threadPath(threadId);

    let entries: string[] = [];
    try {
      entries = await fs.readdir(threadDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const tuples: CheckpointTuple[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'latest.json') continue;

      const filePath = path.join(threadDir, entry);
      try {
        const stored = await this.readCheckpoint(filePath);

        tuples.push({
          checkpoint: stored.checkpoint,
          config: {
            configurable: {
              checkpoint_id: stored.checkpoint.id,
              thread_id: threadId,
            },
          },
          metadata: stored.metadata,
          parentConfig: stored.parentConfig,
          pendingWrites: stored.pendingWrites,
        });
      } catch (error) {
        throw new Error(`Failed to read checkpoint "${filePath}".`, {cause: error});
      }
    }

    // LangGraph expects thread-only lookup to resolve to the newest checkpoint.
    tuples.sort((a, b) => b.checkpoint.ts.localeCompare(a.checkpoint.ts));

    const limit = options?.limit ?? tuples.length;
    let yielded = 0;
    for (const tuple of tuples) {
      if (yielded >= limit) break;
      yield tuple;
      yielded++;
    }
  }

  /**
   * Compact a thread only when no graph invocation is actively writing to it.
   * Pruning from put() can delete a checkpoint before LangGraph attaches its
   * delayed task writes.
   */
  async prune(threadId: string): Promise<void> {
    await this.withLock(this.threadPath(threadId), () => this.pruneThread(threadId));
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = this.getThreadId(config);
    const checkpointId = checkpoint.id;
    const filePath = this.checkpointPath(threadId, checkpointId);

    await this.withLock(this.threadPath(threadId), async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const stored: StoredCheckpoint = {
        checkpoint,
        metadata,
        parentConfig: config.configurable?.checkpoint_id
          ? {
              configurable: {
                checkpoint_id: config.configurable.checkpoint_id,
                thread_id: threadId,
              },
            }
          : undefined,
        pendingWrites: await this.readStagedWrites(threadId, checkpointId),
      };

      await this.writeCheckpoint(filePath, stored);
      await fs.rm(this.stagedWritesPath(threadId, checkpointId), { force: true });
      await writeFileAtomic(
        this.threadIndexPath(threadId),
        JSON.stringify({ checkpointId, timestamp: checkpoint.ts } satisfies ThreadIndex),
      );
    });

    return {
      configurable: {
        checkpoint_id: checkpointId,
        thread_id: threadId,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const checkpointId = this.getCheckpointId(config);
    const threadId = this.getThreadId(config);
    if (!checkpointId) {
      throw new Error('checkpoint_id is required when persisting pending writes.');
    }

    const filePath = this.checkpointPath(threadId, checkpointId);

    await this.withLock(this.threadPath(threadId), async () => {
      const taskWrites: CheckpointPendingWrite[] = writes.map(([channel, value]) => [
        taskId,
        channel,
        value,
      ]);
      try {
        const stored = await this.readCheckpoint(filePath);
        stored.pendingWrites.push(...taskWrites);
        await this.writeCheckpoint(filePath, stored);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const staged = await this.readStagedWrites(threadId, checkpointId);
        staged.push(...taskWrites);
        await this.writeStagedWrites(threadId, checkpointId, staged);
      }
    });
  }

  private assertSerializedCheckpoint(
    serialized: SerializedCheckpoint,
    filePath: string,
  ): void {
    if (
      serialized.version !== 2
      || typeof serialized.type !== 'string'
      || typeof serialized.data !== 'string'
      || typeof serialized.signature !== 'string'
    ) {
      throw new Error(`Unsupported or unauthenticated checkpoint format: ${filePath}`);
    }
  }

  private checkpointPath(threadId: string, checkpointId: string): string {
    return path.join(this.threadPath(threadId), `${this.toPathKey(checkpointId)}.json`);
  }

  private getCheckpointId(config: RunnableConfig): string | undefined {
    const checkpointId = config.configurable?.checkpoint_id;
    return typeof checkpointId === 'string' && checkpointId.length > 0
      ? checkpointId
      : undefined;
  }

  private getThreadId(config: RunnableConfig): string {
    return (config.configurable?.thread_id as string) ?? 'default';
  }

  private async pruneThread(threadId: string): Promise<void> {
    const tuples = [];
    for await (const tuple of this.list({ configurable: { thread_id: threadId } })) {
      tuples.push(tuple);
    }

    for (const tuple of tuples.slice(this.maxCheckpointsPerThread)) {
      await fs.rm(this.checkpointPath(threadId, tuple.checkpoint.id), { force: true });
    }
  }

  private async readCheckpoint(filePath: string): Promise<StoredCheckpoint> {
    await recoverAtomicWrite(filePath);
    const serialized = JSON.parse(await this.readRegularFile(filePath)) as SerializedCheckpoint;
    this.assertSerializedCheckpoint(serialized, filePath);
    if (!verifyHostData(
      this.requireIntegrityKey(),
      'langgraph-checkpoint',
      this.serializedPayload(serialized),
      serialized.signature,
    )) {
      throw new Error(`Checkpoint integrity verification failed: ${filePath}`);
    }

    if (serialized.version !== 2 || typeof serialized.type !== 'string' || typeof serialized.data !== 'string') {
      throw new Error(`Unsupported checkpoint format: ${filePath}`);
    }

    return await this.serde.loadsTyped(
      serialized.type,
      Buffer.from(serialized.data, 'base64'),
    ) as StoredCheckpoint;
  }

  private async readRegularFile(filePath: string): Promise<string> {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Checkpoint path is not a regular file: ${filePath}`);
    }

    return fs.readFile(filePath, 'utf8');
  }

  private async readStagedWrites(
    threadId: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const filePath = this.stagedWritesPath(threadId, checkpointId);
    try {
      await recoverAtomicWrite(filePath);
      const serialized = JSON.parse(await this.readRegularFile(filePath)) as SerializedCheckpoint;
      this.assertSerializedCheckpoint(serialized, filePath);
      if (!verifyHostData(
        this.requireIntegrityKey(),
        'langgraph-checkpoint',
        this.serializedPayload(serialized),
        serialized.signature,
      )) {
        throw new Error(`Checkpoint integrity verification failed: ${filePath}`);
      }

      return await this.serde.loadsTyped(
        serialized.type,
        Buffer.from(serialized.data, 'base64'),
      ) as CheckpointPendingWrite[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private requireIntegrityKey(): Buffer {
    if (!this.integrityKey) {
      throw new Error('PersistentCheckpointSaver.initialize() must complete before use.');
    }

    return this.integrityKey;
  }

  private serializedPayload(serialized: SerializedCheckpoint): string {
    return JSON.stringify({
      data: serialized.data,
      type: serialized.type,
      version: serialized.version,
    });
  }

  private stagedWritesPath(threadId: string, checkpointId: string): string {
    return path.join(this.threadPath(threadId), `${this.toPathKey(checkpointId)}.pending.json`);
  }

  private threadIndexPath(threadId: string): string {
    return path.join(this.threadPath(threadId), 'latest.json');
  }

  private threadPath(threadId: string): string {
    return path.join(this.checkpointsDir, this.toPathKey(threadId));
  }

  private toPathKey(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = NOOP;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async writeCheckpoint(filePath: string, stored: StoredCheckpoint): Promise<void> {
    const [type, data] = await this.serde.dumpsTyped(stored);
    const unsigned = {
      data: Buffer.from(data).toString('base64'),
      type,
      version: 2 as const,
    };
    const serialized: SerializedCheckpoint = {
      ...unsigned,
      signature: signHostData(
        this.requireIntegrityKey(),
        'langgraph-checkpoint',
        JSON.stringify(unsigned),
      ),
    };
    await writeFileAtomic(filePath, JSON.stringify(serialized));
  }

  private async writeStagedWrites(
    threadId: string,
    checkpointId: string,
    writes: CheckpointPendingWrite[],
  ): Promise<void> {
    const [type, data] = await this.serde.dumpsTyped(writes);
    await fs.mkdir(this.threadPath(threadId), { recursive: true });
    const unsigned = {
      data: Buffer.from(data).toString('base64'),
      type,
      version: 2 as const,
    };
    await writeFileAtomic(
      this.stagedWritesPath(threadId, checkpointId),
      JSON.stringify({
        ...unsigned,
        signature: signHostData(
          this.requireIntegrityKey(),
          'langgraph-checkpoint',
          JSON.stringify(unsigned),
        ),
      } satisfies SerializedCheckpoint),
    );
  }
}
