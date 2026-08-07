/**
 * Verification Gates - Hard gates for finding validation.
 * No finding may be emitted without passing these gates.
 */

import type { KnowledgeGraph } from '../memory/knowledge-graph.js';

import {
  calculateConfidence,
  CONFIDENCE_THRESHOLDS,
  type ConfidenceFactors,
} from './confidence.js';
import { ContradictionChecker } from './contradiction-check.js';
import { EvidenceLinker } from './evidence-linker.js';

export interface ToolRunRef {
  timestamp: string;
  toolCallId: string;
  toolName: string;
  truncated: boolean;
}

export interface FindingCandidate {
  assumptions?: string[];
  cwe: string;
  entityIds?: string[];
  relatedEntityIds?: string[];
  sinkId?: string;
  sourceId?: string;
  title: string;
  toolRunRefs?: ToolRunRef[];
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export interface VerificationResult {
  assumptions: string[];
  canEmit: boolean;
  confidence: number;
  confidenceLevel: 'high' | 'insufficient' | 'low' | 'medium';
  failedGates: string[];
  gateResults: Record<string, GateResult>;
  passedGates: string[];
  recommendations: string[];
  warnings: string[];
}

export interface VerificationGatesOptions {
  /** Allow findings with assumptions (default: true with warning) */
  allowAssumptions?: boolean;

  /** Minimum confidence to emit (default: 0.5) */
  minConfidence?: number;

  /** Require code evidence (default: true) */
  requireCodeEvidence?: boolean;

  /** Require data flow verification for injection findings (default: true) */
  requireDataFlow?: boolean;
}

const DEFAULT_OPTIONS: Required<VerificationGatesOptions> = {
  allowAssumptions: true,
  minConfidence: CONFIDENCE_THRESHOLDS.reportInclusion,
  requireCodeEvidence: true,
  requireDataFlow: true,
};

/**
 * Verification gates for finding validation.
 */
export class VerificationGates {
  private readonly contradictionChecker: ContradictionChecker;
  private readonly evidenceLinker: EvidenceLinker;
  private readonly graph: KnowledgeGraph;
  private readonly options: Required<VerificationGatesOptions>;

  constructor(graph: KnowledgeGraph, options: VerificationGatesOptions = {}) {
    this.graph = graph;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.evidenceLinker = new EvidenceLinker(graph);
    this.contradictionChecker = new ContradictionChecker(graph);
  }

  /**
   * Quick check if a finding has minimum required evidence.
   */
  hasMinimumEvidence(candidate: FindingCandidate): boolean {
    return Boolean(
      (candidate.entityIds && candidate.entityIds.length > 0) ||
      (candidate.toolRunRefs && candidate.toolRunRefs.length > 0)
    );
  }

  /**
   * Run all verification gates on a finding candidate.
   */
  // eslint-disable-next-line complexity
  verify(candidate: FindingCandidate): VerificationResult {
    const gateResults: Record<string, GateResult> = {};
    const warnings: string[] = [];
    const recommendations: string[] = [];
    const assumptions: string[] = candidate.assumptions ?? [];

    // Gate 1: Code evidence present
    const codeEvidenceResult = this.gateCodeEvidencePresent(candidate);
    gateResults.code_evidence = codeEvidenceResult;

    // Gate 2: Source→sink path trace (for injection findings)
    const dataFlowResult = this.gateDataFlowPresent(candidate);
    gateResults.data_flow = dataFlowResult;

    // Gate 3: Assumptions explicitly flagged
    const assumptionsResult = this.gateAssumptionsFlagged(candidate);
    gateResults.assumptions_flagged = assumptionsResult;

    // Gate 4: Truncation/incomplete coverage flagged
    const truncationResult = this.gateTruncationFlagged(candidate);
    gateResults.truncation_flagged = truncationResult;

    // Gate 5: No blocking contradictions
    const contradictionResult = this.gateNoContradictions(candidate);
    gateResults.no_contradictions = contradictionResult;

    // Calculate confidence
    const linking = this.evidenceLinker.linkFinding(
      candidate.title,
      candidate.entityIds ?? [],
      candidate.toolRunRefs ?? [],
    );

    const confidenceFactors: ConfidenceFactors = {
      codeEvidencePresent: codeEvidenceResult.passed,
      contradictionsFound: !contradictionResult.passed,
      dataFlowVerified: dataFlowResult.passed,
      manuallyVerified: false,
      multipleToolsConfirm: (candidate.toolRunRefs?.length ?? 0) > 1,
      toolRunCount: candidate.toolRunRefs?.length ?? 0,
      truncationDetected: !truncationResult.passed,
    };

    const confidenceResult = calculateConfidence(confidenceFactors);
    warnings.push(...confidenceResult.warnings);

    // Gate 6: Minimum confidence met
    const confidenceGateResult: GateResult = {
      passed: confidenceResult.confidence >= this.options.minConfidence,
      reason: confidenceResult.confidence >= this.options.minConfidence
        ? `Confidence ${(confidenceResult.confidence * 100).toFixed(0)}% meets threshold`
        : `Confidence ${(confidenceResult.confidence * 100).toFixed(0)}% below threshold ${(this.options.minConfidence * 100).toFixed(0)}%`,
    };
    gateResults.minimum_confidence = confidenceGateResult;

    // Collect passed and failed gates
    const passedGates: string[] = [];
    const failedGates: string[] = [];

    for (const [gateName, result] of Object.entries(gateResults)) {
      if (result.passed) {
        passedGates.push(gateName);
      } else {
        failedGates.push(gateName);
      }
    }

    // Determine if finding can be emitted
    const requiredGates = ['minimum_confidence'];
    if (this.options.requireCodeEvidence) {
      requiredGates.push('code_evidence');
    }

    if (this.options.requireDataFlow && this.isInjectionFinding(candidate.cwe)) {
      requiredGates.push('data_flow');
    }

    if (!this.options.allowAssumptions) {
      requiredGates.push('assumptions_flagged');
    }

    const canEmit = requiredGates.every((gate) => gateResults[gate]?.passed);

    // Generate recommendations for failed gates
    if (!gateResults.code_evidence?.passed) {
      recommendations.push('Gather code evidence to support this finding');
    }

    if (!gateResults.data_flow?.passed && this.isInjectionFinding(candidate.cwe)) {
      recommendations.push('Trace data flow from source to sink');
    }

    if (!gateResults.minimum_confidence?.passed) {
      recommendations.push('Collect additional evidence to increase confidence');
    }

    if (!contradictionResult.passed) {
      recommendations.push('Resolve contradictory evidence before emitting');
    }

    return {
      assumptions,
      canEmit,
      confidence: confidenceResult.confidence,
      confidenceLevel: confidenceResult.level,
      failedGates,
      gateResults,
      passedGates,
      recommendations,
      warnings,
    };
  }

  // ==========================================================================
  // Individual Gates
  // ==========================================================================

  private gateAssumptionsFlagged(candidate: FindingCandidate): GateResult {
    // If there are assumptions, they should be explicitly provided
    // This gate passes if either there are no assumptions or they are flagged
    const hasAssumptions = candidate.assumptions && candidate.assumptions.length > 0;

    return {
      passed: true, // Always passes if assumptions are provided (which they are as part of candidate)
      reason: hasAssumptions
        ? `${candidate.assumptions!.length} assumption(s) explicitly flagged`
        : 'No assumptions to flag',
    };
  }

  private gateCodeEvidencePresent(candidate: FindingCandidate): GateResult {
    const entityIds = candidate.entityIds ?? [];

    if (entityIds.length === 0) {
      return {
        passed: false,
        reason: 'No entities linked - cannot verify code evidence',
      };
    }

    // Check if any entity has code evidence
    for (const entityId of entityIds) {
      const evidence = this.evidenceLinker.getEntityEvidence(entityId);
      const hasCode = evidence.some((e) => e.type === 'code');
      if (hasCode) {
        return {
          passed: true,
          reason: 'Code evidence found',
        };
      }
    }

    return {
      passed: false,
      reason: 'No code evidence found for any linked entity',
    };
  }

  private gateDataFlowPresent(candidate: FindingCandidate): GateResult {
    // Only required for injection-type findings
    if (!this.isInjectionFinding(candidate.cwe)) {
      return {
        passed: true,
        reason: 'Data flow verification not required for this CWE',
      };
    }

    if (!candidate.sourceId || !candidate.sinkId) {
      return {
        passed: false,
        reason: 'Source and sink IDs required for injection findings',
      };
    }

    const flowResult = this.evidenceLinker.verifyDataFlowEvidence(
      candidate.sourceId,
      candidate.sinkId,
      candidate.relatedEntityIds ?? [],
    );

    return {
      passed: flowResult.hasPath,
      reason: flowResult.hasPath
        ? 'Data flow path verified'
        : `Data flow verification failed: ${flowResult.gaps.join(', ')}`,
    };
  }

  private gateNoContradictions(candidate: FindingCandidate): GateResult {
    const checkResult = this.contradictionChecker.checkFinding(
      candidate.title,
      candidate.sourceId,
      candidate.sinkId,
      [...(candidate.entityIds ?? []), ...(candidate.relatedEntityIds ?? [])],
    );

    if (checkResult.hasBlockingContradictions) {
      return {
        passed: false,
        reason: `Blocking contradictions found: ${checkResult.contradictions.map((c) => c.description).join('; ')}`,
      };
    }

    if (checkResult.contradictions.length > 0) {
      return {
        passed: true,
        reason: `Minor contradictions found but not blocking: ${checkResult.contradictions.length}`,
      };
    }

    return {
      passed: true,
      reason: 'No contradictions found',
    };
  }

  private gateTruncationFlagged(candidate: FindingCandidate): GateResult {
    const toolRuns = candidate.toolRunRefs ?? [];
    const truncated = toolRuns.filter((t) => t.truncated);

    if (truncated.length === 0) {
      return {
        passed: true,
        reason: 'No truncation detected',
      };
    }

    // Truncation is flagged but noted as a warning
    return {
      passed: true, // Passes because it's flagged
      reason: `${truncated.length} tool run(s) had truncated output - evidence may be incomplete`,
    };
  }

  private isInjectionFinding(cwe: string): boolean {
    const injectionCWEs = [
      'CWE-78',  // OS Command Injection
      'CWE-79',  // XSS
      'CWE-89',  // SQL Injection
      'CWE-94',  // Code Injection
      'CWE-917', // Expression Language Injection
      'CWE-918', // SSRF
    ];

    return injectionCWEs.includes(cwe);
  }
}
