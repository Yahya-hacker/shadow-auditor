/**
 * Checkpoints - Persistent mission state snapshots for recovery.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { err, ok, type Result, safeParseJson } from '../schema/base.js';
import { type MissionState, missionStateSchema } from './mission-state.js';

export interface CheckpointMetadata {
  checkpointId: string;
  createdAt: string;
  missionId: string;
  phase: string;
  stateHash: string;
}

export interface CheckpointManagerOptions {
  maxCheckpoints?: number;
  runId: string;
  storagePath: string;
}

/**
 * Manages persistent checkpoints for mission state recovery.
 */
export class CheckpointManager {
  private readonly checkpointsDir: string;
  private readonly maxCheckpoints: number;
  private readonly runId: string;

  constructor(options: CheckpointManagerOptions) {
    this.runId = options.runId;
    this.checkpointsDir = path.join(options.storagePath, 'checkpoints');
    this.maxCheckpoints = options.maxCheckpoints ?? 10;
  }

  /**
   * Delete a checkpoint.
   */
  async deleteCheckpoint(checkpointId: string): Promise<Result<void, string>> {
    const checkpointPath = path.join(this.checkpointsDir, `${checkpointId}.json`);
    const metadataPath = path.join(this.checkpointsDir, `${checkpointId}.meta.json`);

    try {
      await fs.rm(checkpointPath, { force: true });
      await fs.rm(metadataPath, { force: true });
      return ok();
    } catch (error) {
      return err(`Failed to delete checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Initialize the checkpoint storage.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.checkpointsDir, { recursive: true });
  }

  /**
   * List all checkpoints for this run.
   */
  async listCheckpoints(): Promise<Result<CheckpointMetadata[], string>> {
    try {
      const files = await fs.readdir(this.checkpointsDir);
      const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

      const checkpoints: CheckpointMetadata[] = [];

      for (const metaFile of metaFiles) {
        const metaPath = path.join(this.checkpointsDir, metaFile);
        try {
          const content = await fs.readFile(metaPath, 'utf8');
          const metadata = JSON.parse(content) as CheckpointMetadata;
          checkpoints.push(metadata);
        } catch (error) {
          console.warn(
            `[CheckpointManager] Skipping invalid metadata file ${metaFile}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }

      return ok(checkpoints);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ok([]);
      }

      return err(`Failed to list checkpoints: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load a checkpoint by ID.
   */
  async loadCheckpoint(checkpointId: string): Promise<Result<MissionState, string>> {
    const checkpointPath = path.join(this.checkpointsDir, `${checkpointId}.json`);

    try {
      const content = await fs.readFile(checkpointPath, 'utf8');
      return safeParseJson(missionStateSchema, content);
    } catch (error) {
      return err(`Failed to load checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load the most recent checkpoint.
   */
  async loadLatestCheckpoint(): Promise<Result<MissionState | null, string>> {
    const checkpoints = await this.listCheckpoints();
    if (!checkpoints.ok) {
      return err(checkpoints.error);
    }

    if (checkpoints.value.length === 0) {
      return ok(null);
    }

    // Sort by creation time descending
    const sorted = checkpoints.value.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return this.loadCheckpoint(sorted[0].checkpointId);
  }

  /**
   * Save a checkpoint of the current mission state.
   */
  async saveCheckpoint(state: MissionState): Promise<Result<CheckpointMetadata, string>> {
    const validation = missionStateSchema.safeParse(state);
    if (!validation.success) {
      return err(`Invalid state: ${validation.error.message}`);
    }

    const stateJson = JSON.stringify(state, null, 2);
    const stateHash = crypto.createHash('sha256').update(stateJson).digest('hex').slice(0, 16);
    const checkpointId = `cp_${Date.now().toString(36)}_${stateHash.slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    const metadata: CheckpointMetadata = {
      checkpointId,
      createdAt,
      missionId: state.missionId,
      phase: state.currentPhase,
      stateHash,
    };

    const checkpointPath = path.join(this.checkpointsDir, `${checkpointId}.json`);
    const metadataPath = path.join(this.checkpointsDir, `${checkpointId}.meta.json`);

    try {
      await fs.writeFile(checkpointPath, stateJson, 'utf8');
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

      // Cleanup old checkpoints
      await this.cleanupOldCheckpoints();

      return ok(metadata);
    } catch (error) {
      return err(`Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clean up old checkpoints to stay within limit.
   */
  private async cleanupOldCheckpoints(): Promise<void> {
    const checkpoints = await this.listCheckpoints();
    if (!checkpoints.ok) return;

    if (checkpoints.value.length <= this.maxCheckpoints) return;

    // Sort by creation time ascending (oldest first)
    const sorted = checkpoints.value.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    // Delete oldest checkpoints
    const toDelete = sorted.slice(0, sorted.length - this.maxCheckpoints);
    for (const checkpoint of toDelete) {
      await this.deleteCheckpoint(checkpoint.checkpointId);
    }
  }
}

/**
 * Compute a hash of the state for change detection.
 */
export function computeStateHash(state: MissionState): string {
  const serialized = JSON.stringify(state);
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}
