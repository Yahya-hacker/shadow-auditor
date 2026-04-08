/**
 * Blackboard - Shared memory for multi-agent collaboration.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { err, ok, type Result, safeParseJson } from '../schema/base.js';
import {
  type AgentRegistration,
  agentRegistrationSchema,
  type AgentRole,
  type BlackboardState,
  blackboardStateSchema,
  type ConflictMarker,
  conflictMarkerSchema,
  type ConflictType,
  type EvidenceClaim,
  evidenceClaimSchema,
  type EvidenceClaimStatus,
} from './hivemind-schema.js';
import { TaskGraph } from './task-graph.js';

export interface BlackboardOptions {
  heartbeatTimeout?: number; // ms before agent considered offline
  runId: string;
  storagePath: string;
}

/**
 * Shared blackboard for multi-agent collaboration.
 */
export class Blackboard {
  private agents: Map<string, AgentRegistration> = new Map();
  private claims: Map<string, EvidenceClaim> = new Map();
  private conflicts: Map<string, ConflictMarker> = new Map();
  private readonly heartbeatTimeout: number;
  private readonly runId: string;
  private readonly snapshotPath: string;
  private readonly taskGraph: TaskGraph;

  private constructor(options: BlackboardOptions) {
    this.runId = options.runId;
    this.snapshotPath = path.join(options.storagePath, 'blackboard.json');
    this.heartbeatTimeout = options.heartbeatTimeout ?? 60_000;
    this.taskGraph = new TaskGraph();
  }

  /**
   * Create or load a blackboard.
   */
  static async create(options: BlackboardOptions): Promise<Blackboard> {
    await fs.mkdir(options.storagePath, { recursive: true });
    const blackboard = new Blackboard(options);
    await blackboard.loadSnapshot();
    return blackboard;
  }

  /**
   * Contest a claim.
   */
  contestClaim(claimId: string, contestingAgentId: string, reason?: string): Result<EvidenceClaim, string> {
    const claim = this.claims.get(claimId);
    if (!claim) {
      return err(`Claim not found: ${claimId}`);
    }

    if (contestingAgentId === claim.agentId) {
      return err('Agent cannot contest its own claim');
    }

    const updated: EvidenceClaim = {
      ...claim,
      contestedBy: [...claim.contestedBy, contestingAgentId],
      status: this.determineClaimStatus(claim.verifiedBy.length, claim.contestedBy.length + 1),
    };

    this.claims.set(claimId, updated);

    // Create conflict marker
    this.createConflict('contradictory_evidence', [claim.agentId, contestingAgentId], {
      claimId,
      reason,
    });

    return ok(updated);
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  /**
   * Create a conflict marker.
   */
  createConflict(
    conflictType: ConflictType,
    involvedAgents: string[],
    details: { claimId?: string; reason?: string; taskId?: string } = {},
  ): ConflictMarker {
    const now = new Date().toISOString();
    const conflictId = `conflict_${crypto.randomBytes(8).toString('hex')}`;

    const conflict: ConflictMarker = {
      conflictId,
      conflictType,
      createdAt: now,
      description: details.reason ?? `${conflictType} between agents`,
      involvedAgents,
      relatedClaims: details.claimId ? [details.claimId] : [],
      relatedTasks: details.taskId ? [details.taskId] : [],
      status: 'open',
    };

    this.conflicts.set(conflictId, conflict);
    return conflict;
  }

  /**
   * Get all active agents.
   */
  getActiveAgents(): AgentRegistration[] {
    const now = Date.now();
    return [...this.agents.values()].filter((agent) => {
      const lastHeartbeat = new Date(agent.lastHeartbeat).getTime();
      return now - lastHeartbeat < this.heartbeatTimeout && agent.status !== 'offline';
    });
  }

  /**
   * Get agents by role.
   */
  getAgentsByRole(role: AgentRole): AgentRegistration[] {
    return this.getActiveAgents().filter((agent) => agent.role === role);
  }

  /**
   * Get claims by status.
   */
  getClaimsByStatus(status: EvidenceClaimStatus): EvidenceClaim[] {
    return [...this.claims.values()].filter((c) => c.status === status);
  }

  /**
   * Get claims for an entity.
   */
  getClaimsForEntity(entityId: string): EvidenceClaim[] {
    return [...this.claims.values()].filter((c) => c.entityId === entityId);
  }

  // ==========================================================================
  // Evidence Claims
  // ==========================================================================

  /**
   * Get open conflicts.
   */
  getOpenConflicts(): ConflictMarker[] {
    return [...this.conflicts.values()].filter((c) => c.status === 'open' || c.status === 'resolving');
  }

  /**
   * Get the task graph.
   */
  getTaskGraph(): TaskGraph {
    return this.taskGraph;
  }

  /**
   * Update agent heartbeat.
   */
  heartbeat(agentId: string, status?: 'active' | 'busy' | 'idle'): Result<AgentRegistration, string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return err(`Agent not found: ${agentId}`);
    }

    const updated: AgentRegistration = {
      ...agent,
      lastHeartbeat: new Date().toISOString(),
      status: status ?? agent.status,
    };

    this.agents.set(agentId, updated);
    return ok(updated);
  }

  /**
   * Mark inactive agents as offline.
   */
  pruneInactiveAgents(): void {
    const now = Date.now();
    for (const [agentId, agent] of this.agents) {
      const lastHeartbeat = new Date(agent.lastHeartbeat).getTime();
      if (now - lastHeartbeat >= this.heartbeatTimeout && agent.status !== 'offline') {
        this.agents.set(agentId, { ...agent, status: 'offline' });
      }
    }
  }

  /**
   * Register an agent.
   */
  registerAgent(role: AgentRole, capabilities: string[] = []): Result<AgentRegistration, string> {
    const now = new Date().toISOString();
    const agentId = `agent_${role}_${crypto.randomBytes(4).toString('hex')}`;

    const registration: AgentRegistration = {
      agentId,
      capabilities,
      lastHeartbeat: now,
      registeredAt: now,
      role,
      status: 'idle',
    };

    const validation = agentRegistrationSchema.safeParse(registration);
    if (!validation.success) {
      return err(`Invalid registration: ${validation.error.message}`);
    }

    this.agents.set(agentId, registration);
    return ok(registration);
  }

  // ==========================================================================
  // Conflict Management
  // ==========================================================================

  /**
   * Resolve a conflict.
   */
  resolveConflict(conflictId: string, resolution: string): Result<ConflictMarker, string> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) {
      return err(`Conflict not found: ${conflictId}`);
    }

    const updated: ConflictMarker = {
      ...conflict,
      resolution,
      resolvedAt: new Date().toISOString(),
      status: 'resolved',
    };

    this.conflicts.set(conflictId, updated);
    return ok(updated);
  }

  /**
   * Save blackboard state.
   */
  async saveSnapshot(): Promise<void> {
    const state: BlackboardState = {
      agents: [...this.agents.values()],
      claims: [...this.claims.values()],
      conflicts: [...this.conflicts.values()],
      consensusRecords: [], // Persisted via dedicated consensus manager flow.
      runId: this.runId,
      schemaVersion: '1.0.0',
      snapshotAt: new Date().toISOString(),
      tasks: this.taskGraph.exportTasks(),
    };

    const validation = blackboardStateSchema.safeParse(state);
    if (!validation.success) {
      throw new Error(`Invalid blackboard state: ${validation.error.message}`);
    }

    await fs.writeFile(this.snapshotPath, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * Submit an evidence claim.
   */
  submitClaim(
    agentId: string,
    claimType: string,
    data: Record<string, unknown>,
    options: { confidence?: number; entityId?: string } = {},
  ): Result<EvidenceClaim, string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return err(`Agent not found: ${agentId}`);
    }

    const now = new Date().toISOString();
    const claimId = `claim_${crypto.randomBytes(8).toString('hex')}`;

    const claim: EvidenceClaim = {
      agentId,
      claimId,
      claimType,
      confidence: options.confidence ?? 0.5,
      contestedBy: [],
      createdAt: now,
      data,
      entityId: options.entityId,
      status: 'proposed',
      verifiedBy: [],
    };

    const validation = evidenceClaimSchema.safeParse(claim);
    if (!validation.success) {
      return err(`Invalid claim: ${validation.error.message}`);
    }

    this.claims.set(claimId, claim);

    // Check for conflicts with existing claims
    this.checkForClaimConflicts(claim);

    return ok(claim);
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  /**
   * Verify a claim.
   */
  verifyClaim(claimId: string, verifyingAgentId: string): Result<EvidenceClaim, string> {
    const claim = this.claims.get(claimId);
    if (!claim) {
      return err(`Claim not found: ${claimId}`);
    }

    if (verifyingAgentId === claim.agentId) {
      return err('Agent cannot verify its own claim');
    }

    const updated: EvidenceClaim = {
      ...claim,
      status: this.determineClaimStatus(claim.verifiedBy.length + 1, claim.contestedBy.length),
      verifiedBy: [...claim.verifiedBy, verifyingAgentId],
    };

    this.claims.set(claimId, updated);
    return ok(updated);
  }

  private checkForClaimConflicts(newClaim: EvidenceClaim): void {
    if (!newClaim.entityId) return;

    const existingClaims = this.getClaimsForEntity(newClaim.entityId);
    for (const existing of existingClaims) {
      if (existing.claimId === newClaim.claimId) continue;
      if (existing.claimType === newClaim.claimType && existing.agentId !== newClaim.agentId) {
        // Potential duplicate finding
        this.createConflict('duplicate_finding', [existing.agentId, newClaim.agentId], {
          reason: `Duplicate ${newClaim.claimType} claim for entity ${newClaim.entityId}`,
        });
      }
    }
  }

  private determineClaimStatus(verifyCount: number, contestCount: number): EvidenceClaimStatus {
    if (contestCount >= 2) {
      return 'rejected';
    }

    if (contestCount > 0) {
      return 'contested';
    }

    if (verifyCount >= 2) {
      return 'consensus';
    }

    if (verifyCount > 0) {
      return 'verified';
    }

    return 'proposed';
  }

  /**
   * Load blackboard state.
   */
  private async loadSnapshot(): Promise<void> {
    try {
      const content = await fs.readFile(this.snapshotPath, 'utf8');
      const result = safeParseJson(blackboardStateSchema, content);

      if (!result.ok) {
        console.warn('[Blackboard] Invalid snapshot, starting fresh:', result.error);
        return;
      }

      const state = result.value;

      // Restore agents
      for (const agent of state.agents) {
        this.agents.set(agent.agentId, agent);
      }

      // Restore claims
      for (const claim of state.claims) {
        this.claims.set(claim.claimId, claim);
      }

      // Restore conflicts
      for (const conflict of state.conflicts) {
        this.conflicts.set(conflict.conflictId, conflict);
      }

      // Restore tasks
      this.taskGraph.importTasks(state.tasks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }
}
