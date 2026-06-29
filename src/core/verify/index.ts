/**
 * Verification module exports.
 */

export type { CodeEvidence } from '../schema/base.js';
export * from './confidence.js';
export * from './contradiction-check.js';
export {
  EvidenceItem,
  EvidenceLink,
  EvidenceLinker,
  LinkingResult,
} from './evidence-linker.js';
export {
  FindingCandidate,
  GateResult,
  ToolRunRef,
  VerificationGates,
  VerificationGatesOptions,
  VerificationResult,
} from './gates.js';
