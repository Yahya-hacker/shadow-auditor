/**
 * Retry an async operation with exponential backoff.
 * Only retries on network/timeout errors, not on auth errors (4xx).
 */

import { logToStderr } from '../../../utils/stderr-logger.js';

type RetryArguments = [
  maxRetries: number,
  baseDelayMs: number,
  signal?: AbortSignal,
  logLabel?: string,
];

const MAX_RETRY_DELAY_MS = 30_000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  ...[
    maxRetries,
    baseDelayMs,
    signal,
    logLabel = 'SemanticIndex',
  ]: RetryArguments
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      signal?.throwIfAborted();
      return await fn();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Error && error.name === 'AbortError') throw error;

      if (attempt >= maxRetries) break;

      const message = error instanceof Error ? error.message : String(error);
      const errorCode = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
      const retryable = error instanceof TypeError ||
        /(?:408|425|429|5\d\d|ECONN|ENET|fetch failed|network|rate.?limit|timeout|timed out|too_many_requests)/i
          .test(`${errorCode} ${message}`);
      if (!retryable) throw error;

      const retryAfterMs = (
        error as {retryAfterMs?: unknown}
      )?.retryAfterMs;
      const exponentialDelay = baseDelayMs * 2**attempt;
      const requestedDelay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? Math.max(0, retryAfterMs)
        : Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
      const delay = Math.min(requestedDelay, MAX_RETRY_DELAY_MS);
      logToStderr(`[${logLabel}] API call failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${message}`);
      await new Promise<void>((resolve, reject) => {
        const abortSignal = signal;
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortSignal?.reason);
        };

        const timer = setTimeout(() => {
          abortSignal?.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        abortSignal?.addEventListener('abort', onAbort, {once: true});
      });
    }
  }

  throw lastError;
}
