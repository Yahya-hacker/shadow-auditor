import { tool } from 'ai';
import { z } from 'zod';
import { type Blackboard } from './blackboard.js';
import { type ModelTier } from './hivemind-schema.js';

export interface BlackboardToolsOptions {
  agentId: string;
  blackboard: Blackboard;
  modelTier?: ModelTier;
  trustScore?: number;
}

export function createBlackboardTools(options: BlackboardToolsOptions) {
  const { agentId, blackboard, modelTier, trustScore } = options;

  return {
    submit_claim: tool({
      description: 'Submit an evidence claim to the shared blackboard for other agents to see and verify. Use this to share findings, traces, or discoveries.',
      inputSchema: z.object({
        claimType: z.enum(['vulnerability_candidate', 'recon_entrypoint', 'recon_dependency', 'dataflow_path', 'taint_source', 'patch_proposal', 'general_evidence']),
        entityId: z.string().optional().describe('Optional canonical ID of the related codebase entity (e.g., function name, vulnerability ID).'),
        confidence: z.number().min(0).max(1).describe('Your confidence in this claim (0.0 to 1.0).'),
        data: z.record(z.unknown()).describe('The structured data payload of the claim. Include detailed context, file paths, and reasoning.'),
      }),
      execute: async ({ claimType, data, confidence, entityId }) => {
        const result = blackboard.submitClaim(agentId, claimType, data, {
          confidence,
          entityId,
          modelTier,
          trustScore,
        });
        if (result.ok) {
          return `Claim submitted successfully. Claim ID: ${result.value.claimId}`;
        }
        return `Failed to submit claim: ${result.error}`;
      },
    }),

    query_claims: tool({
      description: 'Query existing claims on the blackboard submitted by other agents.',
      inputSchema: z.object({
        claimType: z.string().optional().describe('Filter by specific claim type.'),
        entityId: z.string().optional().describe('Filter by specific entity ID.'),
      }),
      execute: async ({ claimType, entityId }) => {
        let claims = blackboard.getSkepticismFilteredClaims(modelTier ?? 'standard');
        
        if (claimType) {
          claims = claims.filter(c => c.claimType === claimType);
        }
        if (entityId) {
          claims = claims.filter(c => c.entityId === entityId);
        }

        if (claims.length === 0) {
          return 'No claims found matching the criteria.';
        }

        return JSON.stringify(claims, null, 2);
      },
    }),

    verify_claim: tool({
      description: 'Verify a claim submitted by another agent, increasing its consensus score.',
      inputSchema: z.object({
        claimId: z.string().describe('The ID of the claim to verify.'),
      }),
      execute: async ({ claimId }) => {
        const result = blackboard.verifyClaim(claimId, agentId);
        if (result.ok) {
          return `Claim ${claimId} verified successfully. New status: ${result.value.status}`;
        }
        return `Failed to verify claim: ${result.error}`;
      },
    }),

    contest_claim: tool({
      description: 'Contest a claim submitted by another agent if you found contradictory evidence.',
      inputSchema: z.object({
        claimId: z.string().describe('The ID of the claim to contest.'),
        reason: z.string().describe('The reason for contesting the claim.'),
      }),
      execute: async ({ claimId, reason }) => {
        const result = blackboard.contestClaim(claimId, agentId, reason);
        if (result.ok) {
          return `Claim ${claimId} contested successfully. New status: ${result.value.status}`;
        }
        return `Failed to contest claim: ${result.error}`;
      },
    }),
  };
}
