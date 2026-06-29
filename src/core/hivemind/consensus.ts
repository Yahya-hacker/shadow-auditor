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
}

export type Vote = 'abstain' | 'approve' | 'reject';

/**
 * Manages consensus voting for multi-agent decisions.
 */
export class ConsensusManager {
  private readonly defaultQuorum: number;
  private readonly defaultTimeout: number;
  private records: Map<string, ConsensusRecord> = new Map();

  constructor(options: ConsensusManagerOptions = {}) {
    this.defaultQuorum = options.defaultQuorum ?? 2;
    this.defaultTimeout = options.defaultTimeout ?? 60_000; // 1 minute
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
   */
  vote(
    consensusId: string,
    agentId: string,
    vote: Vote,
    comment?: string,
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
          comment,
          timestamp: new Date().toISOString(),
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
   */
  private evaluateConsensus(record: ConsensusRecord): {
    decision?: string;
    reached: boolean;
  } {
    const votes = record.votes;
    if (votes.length < this.defaultQuorum) {
      return { reached: false };
    }

    const approves = votes.filter((v) => v.vote === 'approve').length;
    const rejects = votes.filter((v) => v.vote === 'reject').length;
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
