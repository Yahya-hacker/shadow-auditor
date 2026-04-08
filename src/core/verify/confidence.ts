/**
 * Confidence Calculator - Evidence-based confidence scoring.
 */

import type { LinkingResult } from './evidence-linker.js';

export interface ConfidenceFactors {
  codeEvidencePresent: boolean;
  contradictionsFound: boolean;
  dataFlowVerified: boolean;
  manuallyVerified: boolean;
  multipleToolsConfirm: boolean;
  toolRunCount: number;
  truncationDetected: boolean;
}

export interface ConfidenceResult {
  breakdown: Record<string, number>;
  confidence: number;
  level: 'high' | 'insufficient' | 'low' | 'medium';
  warnings: string[];
}

/**
 * Weights for confidence factors.
 */
const CONFIDENCE_WEIGHTS = {
  baseEvidence: 0.2,
  codeEvidence: 0.25,
  dataFlowVerification: 0.2,
  manualVerification: 0.15,
  multiToolConfirmation: 0.15,
  noContradictions: 0.05,
};

/**
 * Penalties for negative factors.
 */
const CONFIDENCE_PENALTIES = {
  contradictions: -0.3,
  noCodeEvidence: -0.2,
  noDataFlow: -0.1,
  singleToolOnly: -0.1,
  truncation: -0.15,
};

/**
 * Calculate confidence score from evidence factors.
 */
export function calculateConfidence(factors: ConfidenceFactors): ConfidenceResult {
  const breakdown: Record<string, number> = {};
  const warnings: string[] = [];
  let confidence = 0;

  // Base evidence score from tool runs
  const toolRunScore = Math.min(factors.toolRunCount * 0.1, 0.3);
  breakdown.tool_runs = toolRunScore;
  confidence += toolRunScore * CONFIDENCE_WEIGHTS.baseEvidence * 5;

  // Code evidence
  if (factors.codeEvidencePresent) {
    breakdown.code_evidence = CONFIDENCE_WEIGHTS.codeEvidence;
    confidence += CONFIDENCE_WEIGHTS.codeEvidence;
  } else {
    breakdown.code_evidence = CONFIDENCE_PENALTIES.noCodeEvidence;
    confidence += CONFIDENCE_PENALTIES.noCodeEvidence;
    warnings.push('No code evidence present - confidence reduced');
  }

  // Data flow verification
  if (factors.dataFlowVerified) {
    breakdown.data_flow = CONFIDENCE_WEIGHTS.dataFlowVerification;
    confidence += CONFIDENCE_WEIGHTS.dataFlowVerification;
  } else {
    breakdown.data_flow = CONFIDENCE_PENALTIES.noDataFlow;
    confidence += CONFIDENCE_PENALTIES.noDataFlow;
    warnings.push('Data flow not verified');
  }

  // Multiple tools confirmation
  if (factors.multipleToolsConfirm) {
    breakdown.multi_tool = CONFIDENCE_WEIGHTS.multiToolConfirmation;
    confidence += CONFIDENCE_WEIGHTS.multiToolConfirmation;
  } else if (factors.toolRunCount <= 1) {
    breakdown.multi_tool = CONFIDENCE_PENALTIES.singleToolOnly;
    confidence += CONFIDENCE_PENALTIES.singleToolOnly;
    warnings.push('Single tool confirmation only');
  }

  // Manual verification
  if (factors.manuallyVerified) {
    breakdown.manual = CONFIDENCE_WEIGHTS.manualVerification;
    confidence += CONFIDENCE_WEIGHTS.manualVerification;
  }

  // Contradictions penalty
  if (factors.contradictionsFound) {
    breakdown.contradictions = CONFIDENCE_PENALTIES.contradictions;
    confidence += CONFIDENCE_PENALTIES.contradictions;
    warnings.push('Contradictory evidence found - confidence significantly reduced');
  } else {
    breakdown.contradictions = CONFIDENCE_WEIGHTS.noContradictions;
    confidence += CONFIDENCE_WEIGHTS.noContradictions;
  }

  // Truncation penalty
  if (factors.truncationDetected) {
    breakdown.truncation = CONFIDENCE_PENALTIES.truncation;
    confidence += CONFIDENCE_PENALTIES.truncation;
    warnings.push('Output truncation detected - evidence may be incomplete');
  }

  // Clamp to [0, 1]
  confidence = Math.max(0, Math.min(1, confidence));

  // Determine level
  let level: ConfidenceResult['level'];
  if (confidence >= 0.7) {
    level = 'high';
  } else if (confidence >= 0.5) {
    level = 'medium';
  } else if (confidence >= 0.3) {
    level = 'low';
  } else {
    level = 'insufficient';
  }

  return {
    breakdown,
    confidence,
    level,
    warnings,
  };
}

/**
 * Calculate confidence from evidence linking result.
 */
export function confidenceFromLinking(
  linking: LinkingResult,
  additionalFactors: Partial<ConfidenceFactors> = {},
): ConfidenceResult {
  const factors: ConfidenceFactors = {
    codeEvidencePresent: linking.links.code !== undefined && linking.links.code.length > 0,
    contradictionsFound: additionalFactors.contradictionsFound ?? false,
    dataFlowVerified: additionalFactors.dataFlowVerified ?? linking.coverage >= 0.7,
    manuallyVerified: additionalFactors.manuallyVerified ?? false,
    multipleToolsConfirm: (linking.links.toolRuns?.length ?? 0) > 1,
    toolRunCount: linking.links.toolRuns?.length ?? 0,
    truncationDetected: linking.links.toolRuns?.some((t) => t.truncated) ?? false,
  };

  return calculateConfidence(factors);
}

/**
 * Minimum confidence thresholds for different actions.
 */
export const CONFIDENCE_THRESHOLDS = {
  /** Minimum confidence for critical findings */
  critical: 0.75,

  /** Minimum confidence for high severity findings */
  highSeverity: 0.6,

  /** Minimum confidence to include in report */
  reportInclusion: 0.5,

  /** Minimum confidence to mark as verified */
  verified: 0.7,
};

/**
 * Check if confidence meets threshold for action.
 */
export function meetsThreshold(
  confidence: number,
  threshold: keyof typeof CONFIDENCE_THRESHOLDS,
): boolean {
  return confidence >= CONFIDENCE_THRESHOLDS[threshold];
}
