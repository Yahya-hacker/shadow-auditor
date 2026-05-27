/**
 * Vector Store - Lightweight embedded vector database.
 * Zero-dependency, filesystem-backed cosine similarity search.
 * Replaces external vectra dependency for air-gapped deployments.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
  entries: VectorEntry[];
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
  private entries: Map<string, VectorEntry> = new Map();
  private readonly snapshotPath: string;

  private constructor(storagePath: string) {
    this.snapshotPath = path.join(storagePath, 'vector-index.json');
  }

  /**
   * Create or load a vector store.
   */
  static async create(storagePath: string): Promise<VectorStore> {
    await fs.mkdir(storagePath, { recursive: true });
    const store = new VectorStore(storagePath);
    await store.loadSnapshot();
    return store;
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
  async saveSnapshot(): Promise<void> {
    const state: VectorStoreState = {
      entries: [...this.entries.values()],
      schemaVersion: '1.0.0',
      snapshotAt: new Date().toISOString(),
    };

    await fs.writeFile(this.snapshotPath, JSON.stringify(state), 'utf8');
  }

  /**
   * Search for nearest neighbors using cosine similarity.
   */
  search(
    queryVector: number[],
    options: {
      filter?: Record<string, unknown>;
      minScore?: number;
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
   * Load store from disk.
   */
  private async loadSnapshot(): Promise<void> {
    try {
      const content = await fs.readFile(this.snapshotPath, 'utf8');
      const state = JSON.parse(content) as VectorStoreState;

      for (const entry of state.entries) {
        this.entries.set(entry.id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
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
      if (metadata[key] !== value) {
        return false;
      }
    }

    return true;
  }
}
