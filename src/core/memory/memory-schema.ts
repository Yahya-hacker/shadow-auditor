/**
 * Memory Fabric Schemas - Typed contracts for knowledge graph and event store.
 */

import { z } from 'zod';

import {
  canonicalIdSchema,
  codeEvidenceSchema,
  confidenceSchema,
  evidenceRefSchema,
  fileLocationSchema,
  SCHEMA_VERSION,
  shortIdSchema,
  timestampSchema,
} from '../schema/base.js';

// ============================================================================
// Entity Types - Normalized nodes in the knowledge graph
// ============================================================================

export const entityTypeSchema = z.enum([
  'file',
  'function',
  'class',
  'endpoint',
  'sink',
  'source',
  'variable',
  'vulnerability',
  'tool_run',
  'technology',
  'credential',
  'data_type',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;

/**
 * Base entity schema - all entities share these fields.
 */
export const baseEntitySchema = z.object({
  canonicalId: canonicalIdSchema,
  confidence: confidenceSchema.default(1),
  createdAt: timestampSchema,
  entityType: entityTypeSchema,
  label: z.string().min(1),
  properties: z.record(z.unknown()).default({}),
  updatedAt: timestampSchema,
});
export type BaseEntity = z.infer<typeof baseEntitySchema>;

/**
 * File entity - represents a source code file.
 */
export const fileEntitySchema = baseEntitySchema.extend({
  entityType: z.literal('file'),
  properties: z.object({
    language: z.string().optional(),
    lineCount: z.number().int().positive().optional(),
    path: z.string().min(1),
    sha256: z.string().optional(),
  }),
});
export type FileEntity = z.infer<typeof fileEntitySchema>;

/**
 * Function entity - represents a function or method.
 */
export const functionEntitySchema = baseEntitySchema.extend({
  entityType: z.literal('function'),
  properties: z.object({
    async: z.boolean().optional(),
    className: z.string().optional(),
    fileCanonicalId: canonicalIdSchema,
    lineEnd: z.number().int().positive().optional(),
    lineStart: z.number().int().positive(),
    name: z.string().min(1),
    parameters: z.array(z.string()).default([]),
    returnType: z.string().optional(),
  }),
});
export type FunctionEntity = z.infer<typeof functionEntitySchema>;

/**
 * Sink entity - data sink (e.g., eval, SQL query, DOM manipulation).
 */
export const sinkEntitySchema = baseEntitySchema.extend({
  entityType: z.literal('sink'),
  properties: z.object({
    category: z.enum(['execution', 'sql', 'dom', 'file', 'network', 'crypto', 'other']),
    fileCanonicalId: canonicalIdSchema,
    functionCanonicalId: canonicalIdSchema.optional(),
    lineNumber: z.number().int().positive(),
    name: z.string().min(1),
  }),
});
export type SinkEntity = z.infer<typeof sinkEntitySchema>;

/**
 * Source entity - user-controlled input source.
 */
export const sourceEntitySchema = baseEntitySchema.extend({
  entityType: z.literal('source'),
  properties: z.object({
    category: z.enum(['request', 'cookie', 'storage', 'url', 'database', 'file', 'env', 'other']),
    fileCanonicalId: canonicalIdSchema,
    functionCanonicalId: canonicalIdSchema.optional(),
    lineNumber: z.number().int().positive(),
    name: z.string().min(1),
  }),
});
export type SourceEntity = z.infer<typeof sourceEntitySchema>;

/**
 * Vulnerability entity - a confirmed or hypothesized vulnerability.
 */
export const vulnerabilityEntitySchema = baseEntitySchema.extend({
  entityType: z.literal('vulnerability'),
  properties: z.object({
    cvssV31Score: z.number().min(0).max(10).optional(),
    cvssV31Vector: z.string().optional(),
    cwe: z.string().regex(/^CWE-\d+$/),
    exploitPath: z.array(canonicalIdSchema).optional(),
    sinkCanonicalId: canonicalIdSchema.optional(),
    sourceCanonicalId: canonicalIdSchema.optional(),
    title: z.string().min(1),
    verified: z.boolean().default(false),
  }),
});
export type VulnerabilityEntity = z.infer<typeof vulnerabilityEntitySchema>;

/**
 * Tool run entity - records a tool execution.
 */
export const toolRunEntitySchema = baseEntitySchema.extend({
  entityType: z.literal('tool_run'),
  properties: z.object({
    durationMs: z.number().int().nonnegative().optional(),
    input: z.record(z.unknown()),
    output: z.unknown().optional(),
    success: z.boolean(),
    toolCallId: shortIdSchema,
    toolName: z.string().min(1),
    truncated: z.boolean().default(false),
  }),
});
export type ToolRunEntity = z.infer<typeof toolRunEntitySchema>;

// ============================================================================
// Edge Types - Relationships between entities
// ============================================================================

export const edgeTypeSchema = z.enum([
  'calls',           // function calls function
  'flows_to',        // data flows from source to sink
  'guards',          // function guards input
  'touches',         // function touches file
  'exploits',        // vulnerability exploits sink
  'contains',        // file contains function
  'depends_on',      // entity depends on another
  'validates',       // tool run validates entity
  'hypothesizes',    // tool run hypothesizes entity
]);
export type EdgeType = z.infer<typeof edgeTypeSchema>;

/**
 * Graph edge schema.
 */
export const graphEdgeSchema = z.object({
  confidence: confidenceSchema.default(1),
  createdAt: timestampSchema,
  edgeId: canonicalIdSchema,
  edgeType: edgeTypeSchema,
  metadata: z.record(z.unknown()).default({}),
  sourceEntityId: canonicalIdSchema,
  targetEntityId: canonicalIdSchema,
  validated: z.boolean().default(false),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

// ============================================================================
// Event Store - Append-only event log
// ============================================================================

export const eventTypeSchema = z.enum([
  'entity_added',
  'entity_updated',
  'edge_added',
  'edge_removed',
  'tool_call',
  'tool_result',
  'hypothesis_created',
  'hypothesis_verified',
  'hypothesis_rejected',
  'checkpoint_created',
  'checkpoint_restored',
  'state_transition',
  'mission_started',
  'mission_completed',
  'finding_created',
]);
export type EventType = z.infer<typeof eventTypeSchema>;

/**
 * Event schema for append-only log.
 */
export const eventSchema = z.object({
  eventId: shortIdSchema,
  eventType: eventTypeSchema,
  payload: z.record(z.unknown()),
  runId: shortIdSchema,
  schemaVersion: z.string().default(SCHEMA_VERSION),
  timestamp: timestampSchema,
});
export type Event = z.infer<typeof eventSchema>;

// ============================================================================
// Knowledge Graph State - Serializable snapshot
// ============================================================================

export const knowledgeGraphStateSchema = z.object({
  edges: z.record(graphEdgeSchema),
  entities: z.record(baseEntitySchema),
  runId: shortIdSchema,
  schemaVersion: z.string().default(SCHEMA_VERSION),
  snapshotAt: timestampSchema,
});
export type KnowledgeGraphState = z.infer<typeof knowledgeGraphStateSchema>;
