/**
 * Consensus - Multi-agent decision making protocol.
 */

import * as crypto from 'node:crypto';

import { err, ok, type Result } from '../schema/base.js';
import {
  type ConsensusRecord,
  consensusRecordSchema,
  type ConsensusStatus,
} from './hivemind-schema.js';

export interface ConsensusManagerOptions {
  defaultQuorum?: number;  // Minimum votes required
  defaultTimeout?: number; // ms before timeout
  trustThreshold?: number; // Minimum trust score for evidence-bearing votes
}

export type Vote = 'abstain' | 'approve' | 'reject';

/**
 * Manages consensus voting for multi-agent decisions.
 */
export class ConsensusManager {
  private readonly defaultQuorum: number;
  private readonly defaultTimeout: number;
  private records: Map<string, ConsensusRecord> = new Map();
  private readonly trustThreshold: number;

  constructor(options: ConsensusManagerOptions = {}) {
    this.defaultQuorum = options.defaultQuorum ?? 2;
    this.defaultTimeout = options.defaultTimeout ?? 60_000; // 1 minute
    // Default threshold aligned with the lowest *participating* model tier
    // (`local` agents have trustScore 0.5). Using 0.7 here made every local
    // verifier ineligible (0.5 < 0.7), so consensus could never be reached in
    // the common self-hosted/Ollama default configuration - a silent dead end.
    // 0.5 keeps ultra-low-trust votes (e.g. 0.2) gated out while letting local
    // agents participate.
    this.trustThreshold = options.trustThreshold ?? 0.5;
  }

  /**
   * Check and close expired proposals.
   */
  checkTimeouts(): ConsensusRecord[] {
    const expired: ConsensusRecord[] = [];
    const now = Date.now();

    for (const [consensusId, record] of this.records) {
      if (record.status !== 'voting') continue;
      if (record.expiresAt && new Date(record.expiresAt).getTime() < now) {
        const result = this.closeVoting(consensusId, 'timeout');
        if (result.ok) {
          expired.push(result.value);
        }
      }
    }

    return expired;
  }

  /**
   * Create a consensus proposal.
   */
  createProposal(
    proposerId: string,
    topic: string,
    proposal: string,
    options: { quorum?: number; timeout?: number } = {},
  ): Result<ConsensusRecord, string> {
    const now = new Date().toISOString();
    const consensusId = `consensus_${crypto.randomBytes(8).toString('hex')}`;
    const timeout = options.timeout ?? this.defaultTimeout;

    const record: ConsensusRecord = {
      consensusId,
      createdAt: now,
      expiresAt: new Date(Date.now() + timeout).toISOString(),
      proposal,
      proposerId,
      status: 'voting',
      topic,
      votes: [],
    };

    const validation = consensusRecordSchema.safeParse(record);
    if (!validation.success) {
      return err(`Invalid consensus record: ${validation.error.message}`);
    }

    this.records.set(consensusId, record);
    return ok(record);
  }

  /**
   * Export records for persistence.
   */
  exportRecords(): ConsensusRecord[] {
    return [...this.records.values()];
  }

  /**
   * Get all active (voting) proposals.
   */
  getActiveProposals(): ConsensusRecord[] {
    return [...this.records.values()].filter((r) => r.status === 'voting');
  }

  /**
   * Get proposals by topic.
   */
  getProposalsByTopic(topic: string): ConsensusRecord[] {
    return [...this.records.values()].filter((r) => r.topic === topic);
  }

  /**
   * Get a consensus record.
   */
  getRecord(consensusId: string): ConsensusRecord | undefined {
    return this.records.get(consensusId);
  }

  /**
   * Import records from persistence.
   */
  importRecords(records: ConsensusRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.consensusId, record);
    }
  }

  /**
   * Cast a vote on a proposal.
   * If evidenceHash and trustScore are supplied, consensus additionally requires
   * a non-empty evidence hash and a trust score above the configured threshold,
   * ensuring hallucinated claims cannot reach consensus.
   */
  vote(
    consensusId: string,
    agentId: string,
    vote: Vote,
    options: { comment?: string; evidenceHash?: string; trustScore?: number } = {},
  ): Result<ConsensusRecord, string> {
    const record = this.records.get(consensusId);
    if (!record) {
      return err(`Consensus record not found: ${consensusId}`);
    }

    if (record.status !== 'voting') {
      return err(`Voting is closed (status: ${record.status})`);
    }

    // Check timeout
    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
      const updated = this.closeVoting(consensusId, 'timeout');
      return updated;
    }

    // Check for duplicate vote
    if (record.votes.some((v) => v.agentId === agentId)) {
      return err('Agent has already voted');
    }

    const updatedRecord: ConsensusRecord = {
      ...record,
      votes: [
        ...record.votes,
        {
          agentId,
          comment: options.comment,
          evidenceHash: options.evidenceHash,
          timestamp: new Date().toISOString(),
          trustScore: options.trustScore,
          vote,
        },
      ],
    };

    // Check if consensus is reached
    const result = this.evaluateConsensus(updatedRecord);
    if (result.reached) {
      updatedRecord.decision = result.decision;
      updatedRecord.status = 'reached';
    }

    this.records.set(consensusId, updatedRecord);
    return ok(updatedRecord);
  }

  /**
   * Close voting on a proposal.
   */
  private closeVoting(
    consensusId: string,
    reason: 'reached' | 'timeout',
  ): Result<ConsensusRecord, string> {
    const record = this.records.get(consensusId);
    if (!record) {
      return err(`Consensus record not found: ${consensusId}`);
    }

    const evaluation = this.evaluateConsensus(record);
    const status: ConsensusStatus = reason === 'timeout' ? 'timeout' : (evaluation.reached ? 'reached' : 'failed');

    const updated: ConsensusRecord = {
      ...record,
      decision: evaluation.decision,
      status,
    };

    this.records.set(consensusId, updated);
    return ok(updated);
  }

  /**
   * Evaluate if consensus has been reached.
   * Requires a simple majority and, when votes include evidence metadata, a
   * non-empty evidence hash and a trust score above the configured threshold.
   */
  private evaluateConsensus(record: ConsensusRecord): {
    decision?: string;
    reached: boolean;
  } {
    const votes = record.votes;

    // Filter out votes that lack required evidence/trust metadata when such
    // metadata is present on *any* vote. This prevents consensus from being
    // reached purely on blind approvals.
    const hasEvidenceMetadata = votes.some((v) => v.evidenceHash !== undefined || v.trustScore !== undefined);
    let eligibleVotes = votes;
    if (hasEvidenceMetadata) {
      eligibleVotes = votes.filter((v) => {
        if (v.vote === 'abstain') return false;
        if (!v.evidenceHash || v.evidenceHash.length === 0) return false;
        if (v.trustScore !== undefined && v.trustScore < this.trustThreshold) return false;
        return true;
      });
    }

    if (eligibleVotes.length < this.defaultQuorum) {
      return { reached: false };
    }

    const approves = eligibleVotes.filter((v) => v.vote === 'approve').length;
    const rejects = eligibleVotes.filter((v) => v.vote === 'reject').length;
    const total = approves + rejects; // Don't count abstains

    if (total === 0) {
      return { reached: false };
    }

    // Simple majority
    if (approves > total / 2) {
      return {
        decision: 'approved',
        reached: true,
      };
    }

    if (rejects > total / 2) {
      return {
        decision: 'rejected',
        reached: true,
      };
    }

    return { reached: false };
  }
}
