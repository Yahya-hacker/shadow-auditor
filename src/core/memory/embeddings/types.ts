/**
 * Shared embedding provider interfaces.
 */

export interface EmbeddingProvider {
  /** Dimension of the embedding vectors produced */
  dimension: number;
  /** Generate embeddings for a batch of texts */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Stable identity for persisted-vector compatibility checks */
  fingerprint: string;
  /** Provider name for logging */
  name: string;
  /** Test the connection to the embedding service. Returns true if healthy. */
  testConnection?(signal?: AbortSignal): Promise<boolean>;
}
