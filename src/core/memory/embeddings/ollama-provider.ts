/**
 * Ollama-based local embedding provider.
 * Default for zero-data-leakage in security tooling.
 */

import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from './types.js';

import { withRetry } from './retry.js';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly fingerprint: string;
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly model: string;

  constructor(options: {
    baseUrl?: string;
    batchSize?: number;
    dimension?: number;
    model?: string;
  } = {}) {
    this.model = options.model ?? 'nomic-embed-text';
    this.baseUrl = (
      options.baseUrl ??
      process.env.OLLAMA_HOST ??
      'http://127.0.0.1:11434'
    ).replace(/\/+$/, '');
    this.batchSize = options.batchSize ?? 16;
    this.dimension = options.dimension ?? 768;
    this.fingerprint = createHash('sha256')
      .update(JSON.stringify([this.name, this.baseUrl, this.model, this.dimension]))
      .digest('hex');

    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0 || this.batchSize > 100) {
      throw new Error('Ollama embedding batchSize must be an integer between 1 and 100.');
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const embeddings = await withRetry(
        () => this.requestEmbeddings(batch, signal, 30_000),
        3,
        1000,
        signal,
      );
      results.push(...embeddings);
    }

    return results;
  }

  async testConnection(signal?: AbortSignal): Promise<boolean> {
    try {
      signal?.throwIfAborted();
      await this.requestEmbeddings(['health check'], signal, 10_000);
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  private async requestEmbeddings(
    inputs: string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<number[][]> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      body: JSON.stringify({input: inputs, model: this.model}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });

    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 1000);
      throw new Error(
        `Ollama embed error (${response.status}): ${detail || response.statusText}`,
      );
    }

    const data = (await response.json()) as {embeddings?: unknown};
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
      throw new Error(
        `Ollama embedding response count mismatch: expected ${inputs.length}, received ${
          Array.isArray(data.embeddings) ? data.embeddings.length : 0
        }.`,
      );
    }

    return data.embeddings.map((embedding, index) => {
      if (
        !Array.isArray(embedding) ||
        embedding.length !== this.dimension ||
        embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw new Error(
          `Ollama embedding ${index} must contain exactly ${this.dimension} finite numbers.`,
        );
      }

      return embedding as number[];
    });
  }
}
