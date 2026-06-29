/**
 * Entity Normalizer - Canonical ID generation and deduplication.
 * Ensures consistent entity identity across the knowledge graph.
 */

import * as crypto from 'node:crypto';

import type { BaseEntity, EntityType } from './memory-schema.js';

/**
 * Generate a canonical ID for an entity based on its identifying properties.
 * Same inputs always produce the same ID for deterministic reproducibility.
 */
export function generateCanonicalId(entityType: EntityType, identifyingProps: Record<string, unknown>): string {
  // Sort keys for deterministic hash
  const sortedKeys = Object.keys(identifyingProps).sort();
  const normalized = sortedKeys.map((k) => `${k}:${JSON.stringify(identifyingProps[k])}`).join('|');

  const hashInput = `${entityType}::${normalized}`;
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  return `${entityType}_${hash}`;
}

/**
 * Generate canonical ID for a file entity.
 */
export function fileCanonicalId(filePath: string): string {
  return generateCanonicalId('file', { path: normalizePath(filePath) });
}

/**
 * Generate canonical ID for a function entity.
 */
export function functionCanonicalId(fileId: string, functionName: string, lineStart: number): string {
  return generateCanonicalId('function', {
    fileCanonicalId: fileId,
    lineStart,
    name: functionName,
  });
}

/**
 * Generate canonical ID for a sink entity.
 */
export function sinkCanonicalId(fileId: string, sinkName: string, lineNumber: number): string {
  return generateCanonicalId('sink', {
    fileCanonicalId: fileId,
    lineNumber,
    name: sinkName,
  });
}

/**
 * Generate canonical ID for a source entity.
 */
export function sourceCanonicalId(fileId: string, sourceName: string, lineNumber: number): string {
  return generateCanonicalId('source', {
    fileCanonicalId: fileId,
    lineNumber,
    name: sourceName,
  });
}

/**
 * Generate canonical ID for a vulnerability entity.
 */
export function vulnerabilityCanonicalId(
  cwe: string,
  sourceId: string | undefined,
  sinkId: string | undefined,
  title: string,
): string {
  return generateCanonicalId('vulnerability', {
    cwe,
    sinkCanonicalId: sinkId ?? 'none',
    sourceCanonicalId: sourceId ?? 'none',
    titleHash: crypto.createHash('sha256').update(title).digest('hex').slice(0, 8),
  });
}

/**
 * Generate canonical ID for an edge.
 */
export function edgeCanonicalId(
  edgeType: string,
  sourceEntityId: string,
  targetEntityId: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${edgeType}::${sourceEntityId}::${targetEntityId}`)
    .digest('hex')
    .slice(0, 16);

  return `edge_${hash}`;
}

/**
 * Normalize file path for consistent hashing.
 */
export function normalizePath(filePath: string): string {
  // Convert to POSIX-style forward slashes
  let normalized = filePath.replaceAll('\\', '/');

  // Remove leading ./
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  // Normalize multiple slashes
  normalized = normalized.replaceAll(/\/+/g, '/');

  return normalized;
}

/**
 * Check if two entities are duplicates based on canonical ID.
 */
export function isDuplicateEntity(a: BaseEntity, b: BaseEntity): boolean {
  return a.canonicalId === b.canonicalId;
}

/**
 * Merge two entities, preferring the newer one's properties.
 */
export function mergeEntities<T extends BaseEntity>(existing: T, incoming: T): T {
  const existingTime = new Date(existing.updatedAt).getTime();
  const incomingTime = new Date(incoming.updatedAt).getTime();

  // Keep the newer update time, merge properties
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    properties: {
      ...existing.properties,
      ...incoming.properties,
    },
    updatedAt: incomingTime > existingTime ? incoming.updatedAt : existing.updatedAt,
  };
}

/**
 * Compute content hash for code evidence deduplication.
 */
export function computeCodeHash(codeSnippet: string): string {
  // Normalize whitespace for consistent hashing
  const normalized = codeSnippet.replaceAll(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
