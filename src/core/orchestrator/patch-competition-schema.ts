/**
 * Patch Competition Schema — Standardized types for the polyglot hybrid
 * multi-agent patch competition pipeline.
 *
 * Three co-equal agents (Security, Language Patterns, TUI Logic) each
 * produce a standardized PatchProposal. The Orchestrator detects conflicts,
 * synthesizes a unified SuperPatch, and verifies it logically.
 */

import { z } from 'zod';

import { confidenceSchema, shortIdSchema, timestampSchema } from '../schema/base.js';

// ============================================================================
// Patch Proposal — Individual agent submission
// ============================================================================

export const patchProposalAgentRoleSchema = z.enum([
  'security_boundaries',   // Agent A: Security & System Boundaries
  'language_patterns',     // Agent B: Language Patterns & Performance
  'tui_state_machine',     // Agent C: TUI Logic & State Machine
]);
export type PatchProposalAgentRole = z.infer<typeof patchProposalAgentRoleSchema>;

/**
 * Standardized patch proposal from a single agent.
 * Follows the polyglot JSON format specified in the architecture.
 */
export const patchProposalSchema = z.object({
  agentRole: patchProposalAgentRoleSchema,
  /** Hash of the base code state this patch was generated against — used for idempotency */
  baseStateHash: z.string().min(1).optional(),
  confidence: confidenceSchema,
  createdAt: timestampSchema,
  filesAffected: z.array(z.string().min(1)).min(1).describe('List of file paths this patch modifies'),
  /** Agent-specific metadata for traceability */
  metadata: z.record(z.unknown()).default({}),
  patchDiff: z.string().min(1).describe('Standard Unified Git Diff format string'),
  proposalId: shortIdSchema,
  rationale: z.string().min(1).describe('Detailed explanation of the issue and the architectural fix'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('medium'),
  targetLanguage: z.string().min(1).describe('Target language (typescript, python, rust, go, etc.)'),
  vulnerabilityType: z.string().min(1).describe('CWE or vulnerability classification'),
});
export type PatchProposal = z.infer<typeof patchProposalSchema>;

// ============================================================================
// Conflict Detection — Types for inter-patch conflicts
// ============================================================================

export const conflictSeveritySchema = z.enum([
  'blocking',   // Cannot merge automatically — human intervention needed
  'warning',    // Can merge with explicit rules, but risky
  'info',       // Informational: overlapping area but no direct conflict
]);
export type ConflictSeverity = z.infer<typeof conflictSeveritySchema>;

/**
 * A single conflict between two patch proposals.
 */
export const patchConflictSchema = z.object({
  conflictId: shortIdSchema,
  /** Classification of the conflict type */
  conflictType: z.enum([
    'same_line_edit',        // Both patches edit the exact same lines differently
    'adjacent_edit',         // Patches touch neighboring lines where order matters
    'semantic_conflict',     // Patches don't overlap textually but conflict semantically
    'import_header_conflict',// Both modify imports/headers differently
    'test_conflict',         // Both modify the same test
  ]),
  description: z.string().min(1),
  /** File where the conflict occurs */
  filePath: z.string().min(1),
  /** The conflicting hunk content from each proposal */
  hunkA: z.string(),
  hunkB: z.string(),
  /** Line ranges in the original file that both patches touch */
  overlappingRangeA: z.object({ end: z.number(), start: z.number() }),
  overlappingRangeB: z.object({ end: z.number(), start: z.number() }),
  /** The two proposals that conflict */
  proposalAId: shortIdSchema,
  proposalBId: shortIdSchema,
  /** If resolvable automatically, the resolution strategy */
  resolutionStrategy: z.enum([
    'merge_both',        // Both changes can be combined (non-overlapping hunks)
    'prefer_security',   // Security fix takes precedence
    'prefer_performance',// Performance fix takes precedence
    'manual_required',   // Needs human decision
    'combine_alternating',// Interleave both changes
  ]).default('manual_required'),
  severity: conflictSeveritySchema,
});
export type PatchConflict = z.infer<typeof patchConflictSchema>;

// ============================================================================
// Hunk Representation — Parsed unified diff segments
// ============================================================================

/**
 * A single hunk from a unified diff.
 * Example unified diff hunk:
 *   @@ -40,7 +40,8 @@ function authenticate() {
 *    const query = "SELECT * FROM users WHERE id=" + userId;   // removed line
 *   +const query = "SELECT * FROM users WHERE id=?";           // added line
 *    const result = db.execute(query);
 */
export const diffHunkSchema = z.object({
  /** Context header from the diff */
  header: z.string(),
  /** Individual lines in the hunk */
  lines: z.array(z.object({
    content: z.string(),
    kind: z.enum(['context', 'removed', 'added']),
    newLineNumber: z.number().int().optional(),
    oldLineNumber: z.number().int().optional(),
  })),
  newCount: z.number().int(),
  /** New file line range (start, count) */
  newStart: z.number().int(),
  oldCount: z.number().int(),
  /** Original file line range (start, count) */
  oldStart: z.number().int(),
});
export type DiffHunk = z.infer<typeof diffHunkSchema>;

/**
 * Parsed representation of a complete unified diff for a single file.
 */
export const parsedFileDiffSchema = z.object({
  filePath: z.string(),
  hunks: z.array(diffHunkSchema),
  /** Added/removed line counts */
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  newFile: z.string().optional(),
  oldFile: z.string().optional(),
});
export type ParsedFileDiff = z.infer<typeof parsedFileDiffSchema>;

// ============================================================================
// Synthesis Result — The output of the orchestrator
// ============================================================================

export const synthesisStatusSchema = z.enum([
  'fully_merged',       // All patches merged without conflicts
  'partially_merged',   // Some conflicts resolved, some require manual review
  'conflicts_remaining',// Blocking conflicts could not be auto-resolved
  'rejected',           // Synthesis rejected (patches fundamentally incompatible)
]);
export type SynthesisStatus = z.infer<typeof synthesisStatusSchema>;

/**
 * Result of the orchestration engine's synthesis pass.
 */
export const synthesisResultSchema = z.object({
  /** List of accepted proposal IDs */
  acceptedProposals: z.array(shortIdSchema),
  /** All detected conflicts */
  conflicts: z.array(patchConflictSchema),
  createdAt: timestampSchema,
  /** Files modified in the unified diff */
  filesModified: z.array(z.string()),
  /** List of partially accepted (merged) proposal IDs */
  mergedProposals: z.array(shortIdSchema),
  /** List of rejected proposal IDs */
  rejectedProposals: z.array(shortIdSchema),
  /** Conflicts that were auto-resolved */
  resolvedConflicts: z.array(patchConflictSchema),
  status: synthesisStatusSchema,
  /** Summary of the synthesis process */
  summary: z.string(),
  synthesisId: shortIdSchema,
  /** The unified Super Patch diff */
  unifiedDiff: z.string(),
  /** Conflicts that require manual review */
  unresolvedConflicts: z.array(patchConflictSchema),
  /** Verification results */
  verification: z.object({
    checks: z.array(z.object({
      checkId: z.string(),
      checkType: z.string(),
      description: z.string(),
      filePath: z.string().optional(),
      status: z.enum(['pass', 'warning', 'fail']),
      suggestion: z.string().optional(),
    })).optional(),
    errors: z.array(z.string()).default([]),
    overallVerdict: z.enum(['approved', 'warning', 'rejected']).optional(),
    passed: z.boolean(),
    warnings: z.array(z.string()).default([]),
  }).optional(),
});
export type SynthesisResult = z.infer<typeof synthesisResultSchema>;

// ============================================================================
// Logical Verification — Static analysis of the synthesized patch
// ============================================================================

export const verificationCheckSchema = z.object({
  checkId: shortIdSchema,
  checkType: z.enum([
    'syntax_validity',       // Does the diff apply cleanly?
    'import_completeness',   // Are all imports present?
    'type_consistency',      // Do types match across the merged changes?
    'control_flow_integrity',// Does the control flow remain valid?
    'idiom_preservation',    // Does the code respect language idioms?
    'interface_bridge',      // Are multi-language bridges intact?
    'test_compatibility',    // Would existing tests still pass?
  ]),
  description: z.string(),
  filePath: z.string().optional(),
  status: z.enum(['pass', 'warning', 'fail']),
  suggestion: z.string().optional(),
});
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;

export const verificationReportSchema = z.object({
  checks: z.array(verificationCheckSchema),
  errors: z.array(z.string()).default([]),
  overallVerdict: z.enum(['approved', 'warning', 'rejected']),
  timestamp: timestampSchema,
  warnings: z.array(z.string()).default([]),
});
export type VerificationReport = z.infer<typeof verificationReportSchema>;
