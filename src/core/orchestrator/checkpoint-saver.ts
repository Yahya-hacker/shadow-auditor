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

interface StoredCheckpoint {
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  parentConfig?: RunnableConfig;
  pendingWrites: CheckpointPendingWrite[];
}

export interface PersistentCheckpointSaverOptions {
  storagePath: string;
}

export class PersistentCheckpointSaver extends BaseCheckpointSaver {
  private readonly checkpointsDir: string;

  constructor(options: PersistentCheckpointSaverOptions) {
    super();
    this.checkpointsDir = path.join(options.storagePath, 'langgraph-checkpoints');
  }

  async deleteThread(threadId: string): Promise<void> {
    const threadDir = path.join(this.checkpointsDir, threadId);
    await fs.rm(threadDir, { force: true, recursive: true });
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const checkpointId = this.getCheckpointId(config);
    const threadId = this.getThreadId(config);
    const filePath = this.checkpointPath(threadId, checkpointId);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const stored: StoredCheckpoint = JSON.parse(content);

      return {
        checkpoint: stored.checkpoint,
        config,
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
    await fs.mkdir(this.checkpointsDir, { recursive: true });
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const threadId = this.getThreadId(config);
    const threadDir = path.join(this.checkpointsDir, threadId);

    let entries: string[] = [];
    try {
      entries = await fs.readdir(threadDir);
    } catch {
      return;
    }

    const tuples: CheckpointTuple[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;

      const filePath = path.join(threadDir, entry);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const stored: StoredCheckpoint = JSON.parse(content);

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
      } catch {
        // Skip corrupt checkpoint files
        continue;
      }
    }

    // Sort by timestamp ascending
    tuples.sort((a, b) => a.checkpoint.ts.localeCompare(b.checkpoint.ts));

    const limit = options?.limit ?? tuples.length;
    let yielded = 0;
    for (const tuple of tuples) {
      if (yielded >= limit) break;
      yield tuple;
      yielded++;
    }
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

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const stored: StoredCheckpoint = {
      checkpoint,
      metadata,
      parentConfig: config.configurable?.parent_checkpoint_id
        ? {
            configurable: {
              checkpoint_id: config.configurable.parent_checkpoint_id,
              thread_id: threadId,
            },
          }
        : undefined,
      pendingWrites: [],
    };

    await fs.writeFile(filePath, JSON.stringify(stored, null, 2), 'utf8');

    return {
      configurable: {
        checkpoint_id: checkpointId,
        thread_id: threadId,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], _taskId: string): Promise<void> {
    const checkpointId = this.getCheckpointId(config);
    const threadId = this.getThreadId(config);
    const filePath = this.checkpointPath(threadId, checkpointId);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const stored: StoredCheckpoint = JSON.parse(content);
      const castWrites = writes as unknown as CheckpointPendingWrite[];
      stored.pendingWrites.push(...castWrites);
      await fs.writeFile(filePath, JSON.stringify(stored, null, 2), 'utf8');
    } catch (error) {
      // ENOENT means the checkpoint file doesn't exist yet; writes have no
      // home, but this is a transient condition that LangGraph manages.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      // Any other error (disk full, permission denied, corrupt JSON) MUST
      // propagate so the operator can investigate.
      throw error;
    }
  }

  private checkpointPath(threadId: string, checkpointId: string): string {
    return path.join(this.checkpointsDir, threadId, `${checkpointId}.json`);
  }

  private getCheckpointId(config: RunnableConfig): string {
    return (config.configurable?.checkpoint_id as string) ?? 'default';
  }

  private getThreadId(config: RunnableConfig): string {
    return (config.configurable?.thread_id as string) ?? 'default';
  }
}
