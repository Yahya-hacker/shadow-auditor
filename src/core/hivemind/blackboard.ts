/**
 * Blackboard - Shared memory for multi-agent collaboration.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { EventStore } from '../memory/event-store.js';
import type { KnowledgeGraph } from '../memory/knowledge-graph.js';

import { recoverAtomicWrite, writeFileAtomic } from '../../utils/fs-atomic.js';
import { logToStderr } from '../../utils/stderr-logger.js';
import { err, ok, type Result, safeParseJson } from '../schema/base.js';
import { ConsensusManager } from './consensus.js';
import {
  type AgentRegistration,
  agentRegistrationSchema,
  type AgentRole,
  type BlackboardState,
  blackboardStateSchema,
  type ConflictMarker,
  type ConflictType,
  type ConsensusRecord,
  type EvidenceClaim,
  evidenceClaimSchema,
  type EvidenceClaimStatus,
  type ModelTier,
  type Task,
} from './hivemind-schema.js';
import { TaskGraph } from './task-graph.js';

export interface BlackboardOptions {
  consensusManager?: ConsensusManager;
  eventStore?: EventStore;
  heartbeatTimeout?: number; // ms before agent considered offline
  knowledgeGraph?: KnowledgeGraph;
  runId: string;
  storagePath: string;
}

export type ClaimListener = (claim: EvidenceClaim) => void;
export type ConflictListener = (conflict: ConflictMarker) => void;
export type TaskListener = (task: Task) => void;

/**
 * Shared blackboard for multi-agent collaboration.
 */
export class Blackboard {
  private agents: Map<string, AgentRegistration> = new Map();
  private agentTrustScores: Map<string, number> = new Map();
  private claims: Map<string, EvidenceClaim> = new Map();
  private claimSubmittedListeners: Set<ClaimListener> = new Set();
  private claimTypeListeners: Map<string, Set<ClaimListener>> = new Map();
  private claimVerifiedListeners: Set<ClaimListener> = new Set();
  private conflictCreatedListeners: Set<ConflictListener> = new Set();
  private conflicts: Map<string, ConflictMarker> = new Map();
  private readonly consensusManager: ConsensusManager;
  private readonly eventStore?: EventStore;
  private readonly heartbeatTimeout: number;
  private readonly knowledgeGraph?: KnowledgeGraph;
  private readonly runId: string;
  private readonly snapshotPath: string;
  private taskCompletedListeners: Set<TaskListener> = new Set();
  private readonly taskGraph: TaskGraph;
  // Serializes mutating operations so concurrent async writes cannot interleave.
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: BlackboardOptions) {
    this.runId = options.runId;
    this.snapshotPath = path.join(options.storagePath, 'blackboard.json');
    this.heartbeatTimeout = options.heartbeatTimeout ?? 60_000;
    this.taskGraph = new TaskGraph();
    this.eventStore = options.eventStore;
    this.knowledgeGraph = options.knowledgeGraph;
    this.consensusManager = options.consensusManager ?? new ConsensusManager();
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
   * Atomic claim and verify operation for cross-agent evidence flow.
   */
  claimAndVerify(
    taskId: string,
    claimId: string,
    verifyingAgentId: string,
  ): Result<{ claim: EvidenceClaim; task: Task; }, string> {
    const claimRes = this.verifyClaim(claimId, verifyingAgentId);
    if (!claimRes.ok) {
      return err(claimRes.error);
    }

    const taskRes = this.taskGraph.claimTask(taskId, verifyingAgentId);
    if (!taskRes.ok) {
      return err(taskRes.error);
    }

    return ok({ claim: claimRes.value, task: taskRes.value });
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  /**
   * Complete a task and notify listeners.
   */
  completeTask(taskId: string, result?: unknown): Result<Task, string> {
    const res = this.taskGraph.completeTask(taskId, result);
    if (res.ok) {
      for (const listener of this.taskCompletedListeners) {
        listener(res.value);
      }
    }

    return res;
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

    if (claim.contestedBy.includes(contestingAgentId)) {
      return err('Agent has already contested this claim');
    }

    const contestingTrustScore = this.agentTrustScores.get(contestingAgentId);
    if (contestingTrustScore === undefined) {
      return err(`Trust score is not registered for contesting agent: ${contestingAgentId}`);
    }

    const updated: EvidenceClaim = {
      ...claim,
      contestedBy: [...claim.contestedBy, contestingAgentId],
      status: this.determineClaimStatus(claim.verifiedBy.length, claim.contestedBy.length + 1),
    };

    this.claims.set(claimId, updated);

    // Cast a rejection vote on the consensus proposal for this claim,
    // including evidence hash and trust score for epistemic gating.
    const proposal = this.consensusManager.getActiveProposals().find((p) => p.topic === claimId);
    if (proposal) {
      this.consensusManager.vote(proposal.consensusId, contestingAgentId, 'reject', {
        evidenceHash: updated.evidenceHash,
        trustScore: contestingTrustScore,
      });
          // Propagate the final consensus decision to the claim status.
          this.applyConsensusDecision(claimId);
        }

        // Create conflict marker
    this.createConflict('contradictory_evidence', [claim.agentId, contestingAgentId], {
      claimId,
      reason,
    });

    return ok(updated);
  }

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

    // Notify listeners
    for (const listener of this.conflictCreatedListeners) {
      listener(conflict);
    }

    return conflict;
  }

  /**
   * Close expired consensus proposals and return the records that timed out.
   *
   * The supervisor calls this each consensus-evaluation superstep so proposals
   * do not linger in 'voting' forever — without it, `checkTimeouts` is never
   * invoked and consensus state never transitions to 'timeout'/'failed'.
   */
  expireConsensusProposals(): ConsensusRecord[] {
    return this.consensusManager.checkTimeouts();
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
   * Get all claims.
   */
  getAllClaims(): EvidenceClaim[] {
    return [...this.claims.values()];
  }

  /**
   * Get all conflicts.
   */
  getAllConflicts(): ConflictMarker[] {
    return [...this.conflicts.values()];
  }

  /**
   * Get claims filtered by minimum trust score.
   */
  getClaimsByMinTrust(minTrustScore: number): EvidenceClaim[] {
    return [...this.claims.values()].filter((c) => c.trustScore >= minTrustScore);
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

  /**
   * Get all consensus records (proposals and their votes).
   *
   * Delegates to the consensus manager so the supervisor can flow consensus
   * state into the checkpointed LangGraph blackboard channel — without this,
   * proposals and votes are only persisted to the JSON snapshot and are lost
   * from graph checkpoints.
   */
  getConsensusRecords(): ConsensusRecord[] {
    return this.consensusManager.exportRecords();
  }

  /**
   * Get open conflicts.
   */
  getOpenConflicts(): ConflictMarker[] {
    return [...this.conflicts.values()].filter((c) => c.status === 'open' || c.status === 'resolving');
  }

  /**
   * Get every registered agent, regardless of heartbeat freshness.
   *
   * Unlike `getActiveAgents`, this does not filter by heartbeat. It is
   * used by the supervisor to reconcile in-memory workers against persisted
   * agent registrations when resuming a run from a checkpoint — a crashed
   * process has stale heartbeats but the agent identities must still map to
   * live workers for task dispatch to resume.
   */
  getRegisteredAgents(): AgentRegistration[] {
    return [...this.agents.values()];
  }

  /**
   * Get the run ID.
   */
  getRunId(): string {
    return this.runId;
  }

  // ==========================================================================
  // Evidence Claims
  // ==========================================================================

  /**
   * Get claims with skepticism annotations for cross-tier consumption.
   *
   * When a premium-tier agent reads claims from a lower-tier agent,
   * claims with trustScore < 0.8 are annotated with a warning prefix
   * in their data so the consuming agent treats them as unverified hints.
   */
  getSkepticismFilteredClaims(consumerTier: ModelTier): Array<EvidenceClaim & { skepticismNote?: string }> {
    const trustThreshold = consumerTier === 'premium' ? 0.8 : 0.5;

    return [...this.claims.values()].map((claim) => {
      if (claim.trustScore < trustThreshold) {
        return {
          ...claim,
          skepticismNote: `[UNVERIFIED HINT — trustScore: ${claim.trustScore}, tier: ${claim.modelTier}] Verify with tools before relying on this data.`,
        };
      }

      return { ...claim };
    });
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
  heartbeat(agentId: string, status?: 'active' | 'busy' | 'idle' | 'offline'): Result<AgentRegistration, string> {
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

  onClaimSubmitted(callback: ClaimListener): () => void {
    this.claimSubmittedListeners.add(callback);
    return () => this.claimSubmittedListeners.delete(callback);
  }

  onClaimVerified(callback: ClaimListener): () => void {
    this.claimVerifiedListeners.add(callback);
    return () => this.claimVerifiedListeners.delete(callback);
  }

  onConflictCreated(callback: ConflictListener): () => void {
    this.conflictCreatedListeners.add(callback);
    return () => this.conflictCreatedListeners.delete(callback);
  }

  // ==========================================================================
  // Conflict Management
  // ==========================================================================

  onTaskCompleted(callback: TaskListener): () => void {
    this.taskCompletedListeners.add(callback);
    return () => this.taskCompletedListeners.delete(callback);
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
    this.agentTrustScores.set(agentId, 0.5);
    return ok(registration);
  }

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

  // ==========================================================================
  // Persistence
  // ==========================================================================

  /**
   * Save blackboard state.
   *
   * Enqueued behind `writeQueue` so that snapshot captures are atomic with
   * respect to concurrent claim submissions — without this, a snapshot write
   * could interleave with a `submitClaim` mutation and produce a corrupt or
   * inconsistent JSON file.
   */
  async saveSnapshot(): Promise<void> {
    return this.enqueueWrite(async () => {
      const state: BlackboardState = {
        agents: [...this.agents.values()],
        claims: [...this.claims.values()],
        conflicts: [...this.conflicts.values()],
        consensusRecords: this.consensusManager.exportRecords(),
        runId: this.runId,
        schemaVersion: '1.0.0',
        snapshotAt: new Date().toISOString(),
        tasks: this.taskGraph.exportTasks(),
      };

      const validation = blackboardStateSchema.safeParse(state);
      if (!validation.success) {
        throw new Error(`Invalid blackboard state: ${validation.error.message}`);
      }

      await writeFileAtomic(this.snapshotPath, JSON.stringify(state, null, 2));
    });
  }

  /**
   * Reset all mission-scoped collaboration state (claims, conflicts, consensus
   * records, agent registrations and trust scores) so a new mission starts from
   * a clean slate. The supervisor calls this when a previous mission has fully
   * finished. Without it, the reporter would re-report the previous run's
   * verified/consensus claims on a new codebase or refactor, and stale agents
   * would accumulate across runs.
   */
  resetForNewMission(): void {
    this.claims.clear();
    this.conflicts.clear();
    this.consensusManager.importRecords([]);
    this.agents.clear();
    this.agentTrustScores.clear();
  }

  setAgentTrustScore(agentId: string, trustScore: number): Result<void, string> {
    if (!this.agents.has(agentId)) {
      return err(`Agent not found: ${agentId}`);
    }

    if (!Number.isFinite(trustScore) || trustScore < 0 || trustScore > 1) {
      return err(`Invalid trust score for agent ${agentId}`);
    }

    this.agentTrustScores.set(agentId, trustScore);
    return ok();
  }

  /**
   * Submit an evidence claim.
   * This operation is async because it persists an event to the event store
   * and computes an evidence hash linking the claim to the knowledge graph.
   */
  async submitClaim(
    agentId: string,
    claimType: string,
    data: Record<string, unknown>,
    options: { confidence?: number; entityId?: string; linkedEntityIds?: string[]; linkedEventIds?: string[]; modelTier?: ModelTier; trustScore?: number } = {},
  ): Promise<Result<EvidenceClaim, string>> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return err(`Agent not found: ${agentId}`);
    }

    const now = new Date().toISOString();
    const claimId = `claim_${crypto.randomBytes(8).toString('hex')}`;

    // Build linked entity list: explicit IDs plus the primary entity if provided.
    const linkedEntityIds = [...new Set([...(options.entityId ? [options.entityId] : []), ...(options.linkedEntityIds ?? [])])];

    // Create a preliminary claim for hashing.
    const preliminaryClaim: EvidenceClaim = {
      agentId,
      claimId,
      claimType,
      confidence: options.confidence ?? 0.5,
      contestedBy: [],
      createdAt: now,
      data,
      entityId: options.entityId,
      evidenceHash: '',
      linkedEntityIds,
      linkedEventIds: [],
      modelTier: options.modelTier ?? 'standard',
      status: 'proposed',
      trustScore: options.trustScore ?? 0.7,
      verifiedBy: [],
    };

    return this.enqueueWrite(async () => {
      // Persist an event so the claim has an audit trail.
      const linkedEventIds: string[] = [...(options.linkedEventIds ?? [])];
      if (this.eventStore) {
        const eventResult = await this.eventStore.append('finding_created', {
          agentId,
          claimId,
          claimType,
          entityId: options.entityId,
          linkedEntityIds,
        });
        if (eventResult.ok) {
          linkedEventIds.push(eventResult.value.eventId);
        }
      }

      const evidenceHash = this.computeEvidenceHash(preliminaryClaim, linkedEventIds, linkedEntityIds);

      const claim: EvidenceClaim = {
        ...preliminaryClaim,
        evidenceHash,
        linkedEventIds,
      };

      const validation = evidenceClaimSchema.safeParse(claim);
      if (!validation.success) {
        return err(`Invalid claim: ${validation.error.message}`);
      }

      this.claims.set(claimId, claim);

      // Trigger consensus review of this claim.
      this.consensusManager.createProposal(agentId, claimId, `Claim ${claimId} of type ${claimType}`, {
        quorum: 2,
        timeout: 60_000,
      });

      // Notify listeners
      for (const listener of this.claimSubmittedListeners) {
        listener(claim);
      }

      const typeListeners = this.claimTypeListeners.get(claimType);
      if (typeListeners) {
        for (const listener of typeListeners) {
          listener(claim);
        }
      }

      // Check for conflicts with existing claims
      this.checkForClaimConflicts(claim);

      return ok(claim);
    });
  }

  // ==========================================================================
  // Trust-Aware Claim Queries
  // ==========================================================================

  subscribeToClaimType(claimType: string, callback: ClaimListener): () => void {
    let listeners = this.claimTypeListeners.get(claimType);
    if (!listeners) {
      listeners = new Set();
      this.claimTypeListeners.set(claimType, listeners);
    }

    listeners.add(callback);
    return () => {
      const current = this.claimTypeListeners.get(claimType);
      if (current) {
        current.delete(callback);
        if (current.size === 0) {
          this.claimTypeListeners.delete(claimType);
        }
      }
    };
  }

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

    if (claim.verifiedBy.includes(verifyingAgentId)) {
      return err('Agent has already verified this claim');
    }

    const verifierTrustScore = this.agentTrustScores.get(verifyingAgentId);
    if (verifierTrustScore === undefined) {
      return err(`Trust score is not registered for verifying agent: ${verifyingAgentId}`);
    }

    const updated: EvidenceClaim = {
      ...claim,
      status: this.determineClaimStatus(claim.verifiedBy.length + 1, claim.contestedBy.length),
      verifiedBy: [...claim.verifiedBy, verifyingAgentId],
    };

    this.claims.set(claimId, updated);

    // Cast an approval vote on the consensus proposal for this claim,
    // including evidence hash and trust score for epistemic gating.
    const proposal = this.consensusManager.getActiveProposals().find((p) => p.topic === claimId);
    if (proposal) {
      this.consensusManager.vote(proposal.consensusId, verifyingAgentId, 'approve', {
        evidenceHash: updated.evidenceHash,
        trustScore: verifierTrustScore,
      });
          // Propagate the final consensus decision to the claim status so the
          // claim reflects the majority verdict, not just raw verify/contest counts.
          this.applyConsensusDecision(claimId);
        }

    // Notify listeners
    for (const listener of this.claimVerifiedListeners) {
      listener(updated);
    }

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

  private computeEvidenceHash(
    claim: EvidenceClaim,
    linkedEventIds: string[],
    linkedEntityIds: string[],
  ): string {
    const payload = JSON.stringify({
      agentId: claim.agentId,
      claimType: claim.claimType,
      data: claim.data,
      entityId: claim.entityId,
      linkedEntityIds: linkedEntityIds.sort(),
      linkedEventIds: linkedEventIds.sort(),
      trustScore: claim.trustScore,
    });

    return crypto.createHash('sha256').update(payload).digest('hex');
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
     * Propagate a final consensus decision to the claim it was created for.
     *
     * Without this, a claim's status is derived purely from raw verify/contest
     * counts (`determineClaimStatus`), and the consensus manager's majority
     * verdict — which weighs vote trust scores and evidence hashes — never
     * influences the label the reporter sees. A majority "reject" in the consensus
     * layer could therefore coexist with the claim still being labeled
     * `verified`/`consensus` by the count heuristic, and vice-versa.
     *
     * When the proposal for a claim has fully closed (`reached` or `timeout`),
     * apply its decision: rejections become `rejected`, approvals stay at the
     * already-computed count-based status. Proposals still `voting` are left
     * untouched so the count heuristic remains the live source of truth until the
     * decision is final.
     */
    private applyConsensusDecision(claimId: string): void {
      const claim = this.claims.get(claimId);
      if (!claim) return;

      const record = this.consensusManager
        .getProposalsByTopic(claimId)
        .find((r) => r.topic === claimId);
      if (!record || record.status === 'voting') return;

      // Apply the consensus verdict only for a *final, explicit* majority
      // rejection. A `failed`/timeout status carries no decision (it merely means
      // not enough eligible votes arrived) and must not void a claim the count
      // heuristic already accepted.
      if (record.decision === 'rejected') {
        this.claims.set(claimId, { ...claim, status: 'rejected' });
      }
    }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
      const result = this.writeQueue.then(operation);
      // Single-settle: the next queued operation chains off `result` so the queue
      // stays linear and a failure is NOT silently swallowed. The caller receives
      // the rejection directly; `saveSnapshot` reaching `evaluateConsensus` lets
      // the run pause or notify instead of silently proceeding on a lost write.
      this.writeQueue = result.then(
        () => undefined,
        (error) => {
          logToStderr(`[Blackboard] Queued write operation failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
      return result;
    }

  /**
   * Load blackboard state.
   */
  private async loadSnapshot(): Promise<void> {
    try {
      await recoverAtomicWrite(this.snapshotPath);
      const content = await fs.readFile(this.snapshotPath, 'utf8');
      const result = safeParseJson(blackboardStateSchema, content);

      if (!result.ok) {
        logToStderr(`[Blackboard] Invalid snapshot, starting fresh: ${result.error}`);
        return;
      }

      const state = result.value;

      // Restore agents
      for (const agent of state.agents) {
        this.agents.set(agent.agentId, agent);
        this.agentTrustScores.set(agent.agentId, 0.5);
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

      // Restore consensus records
      this.consensusManager.importRecords(state.consensusRecords);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }
}
