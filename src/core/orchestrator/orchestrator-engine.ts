/**
 * Orchestrator Evaluation Engine — The master coordinator for the polyglot
 * hybrid multi-agent patch competition pipeline.
 *
 * This engine receives an array of competing PatchProposals from the
 * decentralized audit swarm (Agents A, B, C) and:
 *
 * 1. Detects conflicts between proposals using unified diff analysis
 * 2. Synthesizes a unified "Super Patch" by merging non-conflicting hunks
 *    and applying resolution strategies to conflicts
 * 3. Verifies the synthesized patch for logical correctness
 * 4. Produces a SynthesisResult with full traceability
 *
 * The engine is deterministic: given the same proposals in the same state,
 * it will always produce the same result (idempotency).
 */

import * as crypto from 'node:crypto';

import {
  type PatchProposal,
  type SynthesisResult,
  synthesisResultSchema,
  type SynthesisStatus,
} from './patch-competition-schema.js';
import { detectConflicts } from './patch-conflict-detector.js';
import { verifySynthesizedPatch } from './patch-logical-verifier.js';
import { synthesizePatches } from './patch-synthesizer.js';

export interface OrchestratorEngineOptions {
  /** Language-specific idioms to enforce during verification */
  languageIdioms?: Record<string, string[]>;
  /** Known cross-language interface bridges to protect */
  interfaceBridges?: Array<{ file: string; exports: string[] }>;
  /** Enable strict mode (type checking, deeper analysis) */
  strictMode?: boolean;
  /** Minimum confidence threshold for accepting a proposal */
  minConfidence?: number;
}

/**
 * The Orchestrator Evaluation Engine.
 *
 * Usage:
 *   const engine = new OrchestratorEngine({ strictMode: true });
 *   const result = engine.evaluate(proposals);
 *   if (result.status === 'fully_merged') {
 *     // Apply result.unifiedDiff
 *   } else {
 *     // Review result.unresolvedConflicts
 *   }
 */
export class OrchestratorEngine {
  private readonly options: Required<OrchestratorEngineOptions>;

  constructor(options: OrchestratorEngineOptions = {}) {
    this.options = {
      languageIdioms: options.languageIdioms ?? {},
      interfaceBridges: options.interfaceBridges ?? [],
      strictMode: options.strictMode ?? false,
      minConfidence: options.minConfidence ?? 0.5,
    };
  }

  /**
   * Evaluate a set of competing patch proposals and produce a synthesis result.
   *
   * This is the main entry point. It runs the full pipeline:
   * filter → detect → synthesize → verify → report.
   */
  evaluate(proposals: PatchProposal[]): SynthesisResult {
    // Step 0: Filter out low-confidence proposals
    const qualified = proposals.filter(
      (p) => p.confidence >= this.options.minConfidence,
    );

    if (qualified.length === 0) {
      return this.emptyResult(proposals, 'No proposals met the minimum confidence threshold.');
    }

    if (qualified.length === 1) {
      // Single proposal: no conflicts possible, accept it directly
      const proposal = qualified[0]!;
      const verification = verifySynthesizedPatch(proposal.patchDiff, {
        languageIdioms: this.options.languageIdioms,
        interfaceBridges: this.options.interfaceBridges,
        strictMode: this.options.strictMode,
      });

      const synthesisId = `synth_${crypto.randomBytes(8).toString('hex')}`;
      return {
        synthesisId,
        status: 'fully_merged',
        unifiedDiff: proposal.patchDiff,
        acceptedProposals: [proposal.proposalId],
        mergedProposals: [],
        rejectedProposals: proposals.filter((p) => p.proposalId !== proposal.proposalId).map((p) => p.proposalId),
        conflicts: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        filesModified: proposal.filesAffected,
        summary: `Single proposal accepted from ${proposal.agentRole}. ${verification.overallVerdict === 'approved' ? 'Verification passed.' : `Verification: ${verification.overallVerdict} (${verification.warnings.length} warnings).`}`,
        verification: {
          passed: verification.overallVerdict !== 'rejected',
          overallVerdict: verification.overallVerdict,
          checks: verification.checks,
          warnings: verification.warnings,
          errors: verification.errors,
        },
        createdAt: new Date().toISOString(),
      };
    }

    // Step 1: Detect conflicts
    const conflicts = detectConflicts(qualified);

    // Step 2: Synthesize patches
    const synthesis = synthesizePatches(qualified, conflicts);

    // Step 3: Verify the synthesized patch
    const verification = verifySynthesizedPatch(synthesis.unifiedDiff, {
      languageIdioms: this.options.languageIdioms,
      interfaceBridges: this.options.interfaceBridges,
      strictMode: this.options.strictMode,
    });

    // Step 4: Determine overall status
    let status: SynthesisStatus;
    if (synthesis.unresolvedConflicts.length === 0) {
      status = synthesis.resolvedConflicts.length > 0 ? 'partially_merged' : 'fully_merged';
    } else if (synthesis.unresolvedConflicts.some((c) => c.severity === 'blocking')) {
      status = 'conflicts_remaining';
    } else {
      status = 'partially_merged';
    }

    const synthesisId = `synth_${crypto.randomBytes(8).toString('hex')}`;

    const result: SynthesisResult = {
      synthesisId,
      status,
      unifiedDiff: synthesis.unifiedDiff,
      acceptedProposals: synthesis.acceptedProposals,
      mergedProposals: synthesis.mergedProposals,
      rejectedProposals: synthesis.rejectedProposals,
      conflicts,
      resolvedConflicts: synthesis.resolvedConflicts,
      unresolvedConflicts: synthesis.unresolvedConflicts,
      filesModified: synthesis.filesModified,
      summary: synthesis.summary,
      verification: {
        passed: verification.overallVerdict !== 'rejected',
        overallVerdict: verification.overallVerdict,
        checks: verification.checks,
        warnings: verification.warnings,
        errors: verification.errors,
      },
      createdAt: new Date().toISOString(),
    };

    return result;
  }

  /**
   * Evaluate with verbose logging for debugging.
   */
  evaluateVerbose(proposals: PatchProposal[]): {
    result: SynthesisResult;
    log: string[];
  } {
    const log: string[] = [];
    log.push(`[Orchestrator] Received ${proposals.length} proposals`);
    for (const p of proposals) {
      log.push(`  - ${p.proposalId} (${p.agentRole}): ${p.vulnerabilityType}, ${p.filesAffected.length} files, confidence=${p.confidence}`);
    }

    log.push(`[Orchestrator] Filtering: min confidence = ${this.options.minConfidence}`);
    const qualified = proposals.filter((p) => p.confidence >= this.options.minConfidence);
    log.push(`[Orchestrator] Qualified: ${qualified.length}/${proposals.length}`);

    log.push(`[Orchestrator] Detecting conflicts...`);
    const conflicts = detectConflicts(qualified);
    log.push(`[Orchestrator] Found ${conflicts.length} conflicts`);
    for (const c of conflicts) {
      log.push(`  - ${c.conflictId}: ${c.conflictType} in ${c.filePath} (${c.severity}) → ${c.resolutionStrategy}`);
    }

    log.push(`[Orchestrator] Synthesizing patches...`);
    const synthesis = synthesizePatches(qualified, conflicts);
    log.push(`[Orchestrator] Synthesis: ${synthesis.summary}`);

    log.push(`[Orchestrator] Verifying synthesized patch...`);
    const verification = verifySynthesizedPatch(synthesis.unifiedDiff, {
      languageIdioms: this.options.languageIdioms,
      interfaceBridges: this.options.interfaceBridges,
      strictMode: this.options.strictMode,
    });
    log.push(`[Orchestrator] Verification: ${verification.overallVerdict} (${verification.checks.length} checks, ${verification.warnings.length} warnings, ${verification.errors.length} errors)`);

    const result = this.evaluate(proposals);
    return { result, log };
  }

  private emptyResult(proposals: PatchProposal[], reason: string): SynthesisResult {
    return {
      synthesisId: `synth_${crypto.randomBytes(8).toString('hex')}`,
      status: 'rejected',
      unifiedDiff: '',
      acceptedProposals: [],
      mergedProposals: [],
      rejectedProposals: proposals.map((p) => p.proposalId),
      conflicts: [],
      resolvedConflicts: [],
      unresolvedConflicts: [],
      filesModified: [],
      summary: reason,
      verification: {
        passed: false,
        overallVerdict: 'rejected' as const,
        checks: [],
        warnings: [],
        errors: [reason],
      },
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Factory function for creating a configured OrchestratorEngine.
 */
export function createOrchestratorEngine(
  options?: OrchestratorEngineOptions,
): OrchestratorEngine {
  return new OrchestratorEngine(options);
}
