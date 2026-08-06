/**
 * OpenAI embedding provider (optional, for users who prioritize speed).
 */

import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from './types.js';

import { withRetry } from './retry.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly fingerprint: string;
  readonly name: string;
  private readonly apiKey: string;
  private readonly credentialHeader: 'api-key' | 'authorization';
  private readonly endpointUrl: string;
  private readonly model: string;
  private readonly tokenProvider?: () => Promise<string>;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    credentialHeader?: 'api-key' | 'authorization';
    dimension?: number;
    endpointUrl?: string;
    model?: string;
    providerName?: string;
    tokenProvider?: () => Promise<string>;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.endpointUrl = options.endpointUrl ?? `${baseUrl}/embeddings`;
    this.credentialHeader = options.credentialHeader ?? 'authorization';
    this.tokenProvider = options.tokenProvider;
    this.dimension = options.dimension ?? 1536;
    this.name = options.providerName ?? 'openai';
    this.fingerprint = createHash('sha256')
      .update(JSON.stringify([this.name, this.endpointUrl, this.model, this.dimension]))
      .digest('hex');
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];

    return withRetry(async () => {
      const headers = await this.requestHeaders();
      signal?.throwIfAborted();

      const response = await fetch(this.endpointUrl, {
        body: JSON.stringify({
          input: texts,
          model: this.model,
        }),
        headers,
        method: 'POST',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const responseMessage = await this.readErrorMessage(response);
        const error = new Error(`Embedding API error (${response.status}): ${responseMessage}`) as Error & {
          retryAfterMs?: number;
        };
        const retryAfterMs = response.headers.get('retry-after-ms');
        const retryAfter = response.headers.get('retry-after');
        if (retryAfterMs && Number.isFinite(Number(retryAfterMs))) {
          error.retryAfterMs = Number(retryAfterMs);
        } else if (retryAfter) {
          const seconds = Number(retryAfter);
          error.retryAfterMs = Number.isFinite(seconds)
            ? seconds * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now());
        }

        throw error;
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      if (!Array.isArray(data.data) || data.data.length !== texts.length) {
        throw new Error(
          `Embedding response count mismatch: expected ${texts.length}, received ${data.data?.length ?? 0}.`,
        );
      }

      const ordered = [...data.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      return ordered.map((item, index) => {
        const vector = item.embedding;
        if (
          !Array.isArray(vector) ||
          vector.length !== this.dimension ||
          vector.some((value) => !Number.isFinite(value))
        ) {
          throw new Error(
            `Embedding ${index} has an invalid vector; expected ${this.dimension} finite dimensions.`,
          );
        }

        return vector;
      });
    }, 3, 1000, signal);
  }

  async testConnection(signal?: AbortSignal): Promise<boolean> {
    try {
      signal?.throwIfAborted();
      const headers = await this.requestHeaders();
      signal?.throwIfAborted();

      const response = await fetch(this.endpointUrl, {
        body: JSON.stringify({ input: ['test'], model: this.model }),
        headers,
        method: 'POST',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      return response.ok;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  private async readErrorMessage(response: Response): Promise<string> {
    const fallback = response.statusText || 'request failed';
    try {
      const body = await response.json() as {
        error?: {code?: string; message?: string};
      };
      const code = body.error?.code ? `${body.error.code}: ` : '';
      return `${code}${body.error?.message ?? fallback}`.slice(0, 1000);
    } catch {
      return fallback;
    }
  }

  private async requestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {'Content-Type': 'application/json'};
    const credential = this.tokenProvider ? await this.tokenProvider() : this.apiKey;
    if (!credential) return headers;

    if (this.credentialHeader === 'api-key') {
      headers['api-key'] = credential;
    } else {
      headers.Authorization = `Bearer ${credential}`;
    }

    return headers;
  }
}
