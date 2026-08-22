/**
 * Null embedding provider for testing or when embeddings are unavailable.
 * Generates deterministic pseudo-random vectors from content hashes.
 */

import * as crypto from 'node:crypto';

import type { EmbeddingProvider } from './types.js';

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly fingerprint: string;
  readonly name = 'null';

  constructor(dimension = 128) {
    this.dimension = dimension;
    this.fingerprint = `null:${dimension}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.deterministicVector(text));
  }

  async testConnection(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    return true;
  }

  private deterministicVector(text: string): number[] {
    const hash = crypto.createHash('sha256').update(text).digest();
    const vector: number[] = [];

    for (let i = 0; i < this.dimension; i++) {
      // Use hash bytes cyclically to generate pseudo-random floats in [-1, 1]
      const byteIndex = i % hash.length;
      vector.push((hash[byteIndex] / 127.5) - 1);
    }

    // Normalize to unit vector
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }
}
