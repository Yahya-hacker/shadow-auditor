import { z } from 'zod';

import type { EnhancedFinding } from '../output/finding-schema.js';

import { enhancedFindingSchema } from '../output/finding-schema.js';

export function createReportFindingTool(
  recordFinding: (
    finding: EnhancedFinding,
    sourceClaimId: string,
  ) => { added: boolean; reason?: string },
) {
  return {
    description:
      'Record one verified security vulnerability in the machine-readable audit report. ' +
      'Call once per distinct vulnerability before finish_task. Do not record speculative issues; ' +
      'include the exact confirmed sourceClaimId plus concrete locations, evidence, CWE, CVSS, ' +
      'exploitability, and remediation.',
    execute(input: EnhancedFinding & { sourceClaimId: string }) {
      const { sourceClaimId, ...finding } = input;
      const result = recordFinding(finding, sourceClaimId);
      return {
        accepted: result.added,
        message: result.added
          ? `Finding ${finding.vulnId} recorded in the audit report.`
          : `Finding ${finding.vulnId} rejected: ${result.reason ?? 'unknown reason'}.`,
        reason: result.reason,
        vulnId: finding.vulnId,
      };
    },
    inputSchema: enhancedFindingSchema.extend({
      sourceClaimId: z.string().min(1).describe(
        'The exact confirmed candidate or claim ID represented by this finding.',
      ),
    }),
  };
}

export function createStagedReportFindingTool() {
  return {
    description:
      'Stage one verified security vulnerability for provenance validation. ' +
      'Call once per distinct confirmed vulnerability before finish_task and include the exact sourceClaimId.',
    execute(input: EnhancedFinding & { sourceClaimId: string }) {
      return {
        accepted: true,
        message: `Finding ${input.vulnId} staged for provenance validation.`,
        sourceClaimId: input.sourceClaimId,
        vulnId: input.vulnId,
      };
    },
    inputSchema: enhancedFindingSchema.extend({
      sourceClaimId: z.string().min(1).describe(
        'The exact confirmed candidate or claim ID represented by this finding.',
      ),
    }),
  };
}
