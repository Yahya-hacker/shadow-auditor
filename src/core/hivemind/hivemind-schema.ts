/**
 * Hive-Mind Schemas - Typed contracts for multi-agent collaboration.
 */

import { z } from 'zod';

import { canonicalIdSchema, confidenceSchema, shortIdSchema, timestampSchema } from '../schema/base.js';

// ============================================================================
// Agent Role Schema
// ============================================================================

export const agentRoleSchema = z.enum([
  'recon',          // Reconnaissance and discovery
  'taint-tracer',   // Data flow tracing
  'exploit-analyst', // Exploit analysis and verification
  'patch-engineer', // Remediation suggestions
  'verifier',       // Finding verification
  'reporter',       // Report generation
  'orchestrator',   // Coordination (main agent)
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

/**
 * Agent registration.
 */
export const agentRegistrationSchema = z.object({
  agentId: shortIdSchema,
  capabilities: z.array(z.string()).default([]),
  lastHeartbeat: timestampSchema,
  registeredAt: timestampSchema,
  role: agentRoleSchema,
  status: z.enum(['active', 'idle', 'busy', 'offline']).default('idle'),
});
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

// ============================================================================
// Task Schema
// ============================================================================

export const taskPrioritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskStatusSchema = z.enum([
  'pending',      // Waiting to be claimed
  'claimed',      // Claimed by an agent
  'in_progress',  // Being worked on
  'completed',    // Successfully completed
  'failed',       // Failed with error
  'blocked',      // Blocked by dependency
  'cancelled',    // Cancelled
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * A task in the task queue.
 */
export const taskSchema = z.object({
  assignedAgent: shortIdSchema.optional(),
  claimedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  dependencies: z.array(shortIdSchema).default([]),
  description: z.string().min(1),
  errorMessage: z.string().optional(),
  parameters: z.record(z.unknown()).default({}),
  priority: taskPrioritySchema,
  requiredRole: agentRoleSchema.optional(),
  result: z.unknown().optional(),
  status: taskStatusSchema,
  taskId: shortIdSchema,
  taskType: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  updatedAt: timestampSchema,
});
export type Task = z.infer<typeof taskSchema>;

// ============================================================================
// Evidence Claim Schema
// ============================================================================

export const evidenceClaimStatusSchema = z.enum([
  'proposed',     // Proposed but not verified
  'verified',     // Verified by another agent
  'contested',    // Contested by another agent
  'rejected',     // Rejected after review
  'consensus',    // Consensus reached
]);
export type EvidenceClaimStatus = z.infer<typeof evidenceClaimStatusSchema>;

/**
 * An evidence claim from an agent.
 */
export const evidenceClaimSchema = z.object({
  agentId: shortIdSchema,
  claimId: shortIdSchema,
  claimType: z.string().min(1),
  confidence: confidenceSchema,
  contestedBy: z.array(shortIdSchema).default([]),
  createdAt: timestampSchema,
  data: z.record(z.unknown()),
  entityId: canonicalIdSchema.optional(),
  status: evidenceClaimStatusSchema,
  verifiedBy: z.array(shortIdSchema).default([]),
});
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

// ============================================================================
// Conflict Marker Schema
// ============================================================================

export const conflictTypeSchema = z.enum([
  'duplicate_finding',     // Multiple agents found same issue
  'contradictory_evidence', // Conflicting evidence
  'resource_contention',   // Multiple agents targeting same resource
  'confidence_disagreement', // Disagreement on confidence
]);
export type ConflictType = z.infer<typeof conflictTypeSchema>;

/**
 * A conflict marker indicating disagreement between agents.
 */
export const conflictMarkerSchema = z.object({
  conflictId: shortIdSchema,
  conflictType: conflictTypeSchema,
  createdAt: timestampSchema,
  description: z.string().min(1),
  involvedAgents: z.array(shortIdSchema),
  relatedClaims: z.array(shortIdSchema).default([]),
  relatedTasks: z.array(shortIdSchema).default([]),
  resolution: z.string().optional(),
  resolvedAt: timestampSchema.optional(),
  status: z.enum(['open', 'resolving', 'resolved', 'escalated']).default('open'),
});
export type ConflictMarker = z.infer<typeof conflictMarkerSchema>;

// ============================================================================
// Consensus Schema
// ============================================================================

export const consensusStatusSchema = z.enum([
  'voting',       // Votes being collected
  'reached',      // Consensus reached
  'failed',       // Failed to reach consensus
  'timeout',      // Timed out
]);
export type ConsensusStatus = z.infer<typeof consensusStatusSchema>;

/**
 * A consensus record for multi-agent decisions.
 */
export const consensusRecordSchema = z.object({
  consensusId: shortIdSchema,
  createdAt: timestampSchema,
  decision: z.string().optional(),
  expiresAt: timestampSchema.optional(),
  proposal: z.string().min(1),
  proposerId: shortIdSchema,
  status: consensusStatusSchema,
  topic: z.string().min(1),
  votes: z.array(
    z.object({
      agentId: shortIdSchema,
      comment: z.string().optional(),
      timestamp: timestampSchema,
      vote: z.enum(['approve', 'reject', 'abstain']),
    })
  ).default([]),
});
export type ConsensusRecord = z.infer<typeof consensusRecordSchema>;

// ============================================================================
// Blackboard State Schema
// ============================================================================

export const blackboardStateSchema = z.object({
  agents: z.array(agentRegistrationSchema).default([]),
  claims: z.array(evidenceClaimSchema).default([]),
  conflicts: z.array(conflictMarkerSchema).default([]),
  consensusRecords: z.array(consensusRecordSchema).default([]),
  runId: shortIdSchema,
  schemaVersion: z.string().default('1.0.0'),
  snapshotAt: timestampSchema,
  tasks: z.array(taskSchema).default([]),
});
export type BlackboardState = z.infer<typeof blackboardStateSchema>;
