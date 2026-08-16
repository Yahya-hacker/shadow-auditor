/**
 * Vector Store - Lightweight embedded vector database.
 * Zero-dependency, filesystem-backed cosine similarity search.
 * Replaces external vectra dependency for air-gapped deployments.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { recoverAtomicWrite, writeFileAtomic } from '../../utils/fs-atomic.js';

export interface VectorEntry {
  id: string;
  metadata: Record<string, unknown>;
  vector: number[];
}

export interface VectorSearchResult {
  entry: VectorEntry;
  score: number;
}

export interface VectorStoreState {
  embeddingFingerprint: string;
  entries: VectorEntry[];
  generation?: string;
  schemaVersion: string;
  snapshotAt: string;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [i, element] of a.entries()) {
    dotProduct += element * b[i];
    normA += element * element;
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Lightweight, file-backed vector store.
 * Supports cosine similarity search and metadata filtering.
 */
export class VectorStore {
  readonly restoredCompatibleSnapshot: boolean;
  readonly snapshotGeneration?: string;
  private readonly embeddingFingerprint: string;
  private entries: Map<string, VectorEntry> = new Map();
  private readonly snapshotPath: string;

  private constructor(
    storagePath: string,
    embeddingFingerprint: string,
    restoredCompatibleSnapshot = false,
    snapshotGeneration?: string,
  ) {
    this.embeddingFingerprint = embeddingFingerprint;
    this.restoredCompatibleSnapshot = restoredCompatibleSnapshot;
    this.snapshotGeneration = snapshotGeneration;
    this.snapshotPath = path.join(storagePath, 'vector-index.json');
  }

  /**
   * Create or load a vector store.
   */
  static async create(storagePath: string, embeddingFingerprint: string): Promise<VectorStore> {
    await fs.mkdir(storagePath, { recursive: true });
    const snapshotPath = path.join(storagePath, 'vector-index.json');
    try {
      await recoverAtomicWrite(snapshotPath);
      const content = await fs.readFile(snapshotPath, 'utf8');
      const state = JSON.parse(content) as Partial<VectorStoreState>;
      const compatible = state.embeddingFingerprint === embeddingFingerprint;
      const store = new VectorStore(storagePath, embeddingFingerprint, compatible, state.generation);
      if (compatible && Array.isArray(state.entries)) {
        for (const entry of state.entries) store.entries.set(entry.id, entry);
      }

      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new VectorStore(storagePath, embeddingFingerprint);
    }
  }

  /**
   * Number of entries in the store.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Delete an entry by ID.
   */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Delete entries matching a metadata filter.
   */
  deleteByMetadata(filter: Record<string, unknown>): number {
    let deleted = 0;
    for (const [id, entry] of this.entries) {
      if (this.matchesFilter(entry.metadata, filter)) {
        this.entries.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Get an entry by ID.
   */
  get(id: string): undefined | VectorEntry {
    return this.entries.get(id);
  }

  /**
   * Check if an entry exists.
   */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Save store to disk.
   */
  async saveSnapshot(generation?: string): Promise<void> {
    const state: VectorStoreState = {
      embeddingFingerprint: this.embeddingFingerprint,
      entries: [...this.entries.values()],
      generation,
      schemaVersion: '3.0.0',
      snapshotAt: new Date().toISOString(),
    };

    await writeFileAtomic(this.snapshotPath, JSON.stringify(state));
  }

  /**
   * Search for nearest neighbors using cosine similarity.
   */
  search(
    queryVector: number[],
    options: {
      filter?: Record<string, unknown>;
      minScore?: number;
      predicate?: (metadata: Record<string, unknown>) => boolean;
      topK?: number;
    } = {},
  ): VectorSearchResult[] {
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0;
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      // Apply metadata filter
      if (options.filter && !this.matchesFilter(entry.metadata, options.filter)) {
        continue;
      }

      if (options.predicate && !options.predicate(entry.metadata)) continue;

      const score = cosineSimilarity(queryVector, entry.vector);
      if (score >= minScore) {
        results.push({ entry, score });
      }
    }

    // Sort by score descending and return top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Upsert a vector entry.
   */
  upsert(entry: VectorEntry): void {
    this.entries.set(entry.id, entry);
  }

  /**
   * Upsert multiple vector entries.
   */
  upsertBatch(entries: VectorEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  /**
   * Check if metadata matches a filter (MongoDB-style partial match).
   */
  private matchesFilter(
    metadata: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): boolean {
    for (const [key, value] of Object.entries(filter)) {
      const actual = metadata[key];
      // Coerce both sides to strings so a numeric filter value (e.g. 1)
      // matches a string metadata value ('1') and vice versa. The strict !==
      // check silently dropped every candidate when the store held one type
      // and the filter used another, making filters match nothing.
      if (String(actual) !== String(value)) {
        return false;
      }
    }

    return true;
  }
}
