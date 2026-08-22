import { z } from 'zod';

import { type Blackboard } from './blackboard.js';
import { EvidenceTracker } from './evidence-tracker.js';
import { type ModelTier } from './hivemind-schema.js';

export interface BlackboardToolsOptions {
  agentId: string;
  blackboard: Blackboard;
  evidenceTracker?: EvidenceTracker;
  modelTier?: ModelTier;
  trustScore?: number;
}

export function createBlackboardTools(options: BlackboardToolsOptions) {
  const { agentId, blackboard, evidenceTracker, modelTier, trustScore } = options;
  const submitClaimInputSchema = z.object({
    claimType: z.enum([
      'vulnerability_candidate',
      'recon_entrypoint',
      'recon_dependency',
      'dataflow_path',
      'taint_source',
      'patch_proposal',
      'general_evidence',
    ]),
    confidence: z.number().min(0).max(1).describe('Your confidence in this claim (0.0 to 1.0).'),
    data: z
      .record(z.unknown())
      .describe('The structured data payload of the claim. Include detailed context, file paths, and reasoning.'),
    entityId: z
      .string()
      .optional()
      .describe(
        'Optional canonical ID of the related codebase entity (e.g., function name, vulnerability ID).',
      ),
  });
  const queryClaimsInputSchema = z.object({
    claimType: z.string().optional().describe('Filter by specific claim type.'),
    entityId: z.string().optional().describe('Filter by specific entity ID.'),
  });
  const verifyClaimInputSchema = z.object({
    claimId: z.string().describe('The ID of the claim to verify.'),
  });
  const contestClaimInputSchema = z.object({
    claimId: z.string().describe('The ID of the claim to contest.'),
    reason: z.string().describe('The reason for contesting the claim.'),
  });

  return {
    contest_claim: {
      description: 'Contest a claim submitted by another agent if you found contradictory evidence.',
      async execute({ claimId, reason }: z.infer<typeof contestClaimInputSchema>) {
        const result = blackboard.contestClaim(claimId, agentId, reason);
        if (result.ok) {
          return `Claim ${claimId} contested successfully. New status: ${result.value.status}`;
        }

        return `Failed to contest claim: ${result.error}`;
      },
      inputSchema: contestClaimInputSchema,
    },
    query_claims: {
      description: 'Query existing claims on the blackboard submitted by other agents.',
      async execute({ claimType, entityId }: z.infer<typeof queryClaimsInputSchema>) {
        let claims = blackboard.getSkepticismFilteredClaims(modelTier ?? 'standard');

        if (claimType) {
          claims = claims.filter((claim) => claim.claimType === claimType);
        }

        if (entityId) {
          claims = claims.filter((claim) => claim.entityId === entityId);
        }

        if (claims.length === 0) {
          return 'No claims found matching the criteria.';
        }

        return JSON.stringify(claims, null, 2);
      },
      inputSchema: queryClaimsInputSchema,
    },
    submit_claim: {
      description:
        'Submit an evidence claim to the shared blackboard for other agents to see and verify. Use this to share findings, traces, or discoveries.',
      async execute({ claimType, confidence, data, entityId }: z.infer<typeof submitClaimInputSchema>) {
        const linkedEventIds = evidenceTracker?.getLinkedEventIds() ?? [];
        const linkedEntityIds = [
          ...(entityId ? [entityId] : []),
          ...(evidenceTracker?.getLinkedEntityIds() ?? []),
        ];

        const result = await blackboard.submitClaim(agentId, claimType, data, {
          confidence,
          entityId,
          linkedEntityIds,
          linkedEventIds,
          modelTier,
          trustScore,
        });
        if (result.ok) {
          evidenceTracker?.addEvents(result.value.linkedEventIds);
          evidenceTracker?.addEntity(result.value.claimId);
          return `Claim submitted successfully. Claim ID: ${result.value.claimId}`;
        }

        return `Failed to submit claim: ${result.error}`;
      },
      inputSchema: submitClaimInputSchema,
    },
    verify_claim: {
      description: 'Verify a claim submitted by another agent, increasing its consensus score.',
      async execute({ claimId }: z.infer<typeof verifyClaimInputSchema>) {
        const result = blackboard.verifyClaim(claimId, agentId);
        if (result.ok) {
          return `Claim ${claimId} verified successfully. New status: ${result.value.status}`;
        }

        return `Failed to verify claim: ${result.error}`;
      },
      inputSchema: verifyClaimInputSchema,
    },
  };
}
