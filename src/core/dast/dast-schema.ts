/**
 * DAST Schema - Typed contracts for dynamic application security testing.
 *
 * Defines Zod schemas for sandbox execution evidence, OAST callbacks,
 * and exploit proof-of-concept records.
 */

import { z } from 'zod';

import { SCHEMA_VERSION } from '../schema/base.js';

// =============================================================================
// Sandbox Execution
// =============================================================================

export const sandboxExecResultSchema = z.object({
  command: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  timestamp: z.string().datetime({ offset: true }),
});
export type SandboxExecResult = z.infer<typeof sandboxExecResultSchema>;

// =============================================================================
// OAST Callbacks
// =============================================================================

export const oastCallbackSchema = z.object({
  headers: z.record(z.string()),
  method: z.string().min(1),
  requestBody: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }),
  url: z.string().min(1),
});
export type OastCallback = z.infer<typeof oastCallbackSchema>;

// =============================================================================
// DAST Validation
// =============================================================================

export const dastValidationResultSchema = z.object({
  endpoint: z.string().min(1),
  method: z.string().min(1),
  oastCallbacks: z.array(oastCallbackSchema).default([]),
  payload: z.string().min(1),
  responseBody: z.string().optional(),
  responseStatus: z.number().int().optional(),
  validated: z.boolean(),
});
export type DastValidationResult = z.infer<typeof dastValidationResultSchema>;

// =============================================================================
// Exploit Proof of Concept
// =============================================================================

export const exploitProofOfConceptSchema = z.object({
  /** The DAST validation result (payload, response, etc.) */
  dastResult: dastValidationResultSchema.optional(),

  /** Finding ID this PoC validates */
  findingId: z.string().min(1),

  /** OAST callbacks captured during exploitation */
  oastCallbacks: z.array(oastCallbackSchema).default([]),

  /** Raw sandbox execution logs (verbatim, never LLM-modified) */
  sandboxLogs: z.array(sandboxExecResultSchema).default([]),

  /** Schema version */
  schemaVersion: z.string().default(SCHEMA_VERSION),

  /** When this PoC was captured */
  timestamp: z.string().datetime({ offset: true }),

  /** Whether the exploit was successfully validated */
  validated: z.boolean(),
});
export type ExploitProofOfConcept = z.infer<typeof exploitProofOfConceptSchema>;
