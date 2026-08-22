import { expect } from 'chai';

import {
  calculateConfidence,
  type ConfidenceFactors,
} from '../src/core/verify/confidence.js';

function baseFactors(overrides: Partial<ConfidenceFactors> = {}): ConfidenceFactors {
  return {
    codeEvidencePresent: true,
    contradictionsFound: false,
    dataFlowVerified: true,
    manuallyVerified: true,
    multipleToolsConfirm: true,
    toolRunCount: 3,
    truncationDetected: false,
    ...overrides,
  };
}

describe('confidence calculation', () => {
  it('bounds the tool-run contribution by the baseEvidence weight', () => {
    // toolRunScore caps at 0.3. Before the fix it was multiplied by
    // baseEvidence (0.2) THEN by an extra constant 5, so many tool runs could
    // inject up to 0.3 straight into confidence as an unweighted floored
    // contribution and dominate every other factor. With the fix the
    // contribution is toolRunScore * 0.2, bounded well below the *named*
    // weight's intended 0.2 share.
    const few = calculateConfidence(baseFactors({ toolRunCount: 1 }));
    const many = calculateConfidence(baseFactors({ toolRunCount: 6 }));

    // toolRunScore(1) = 0.1, contribution = 0.02.
    expect(few.breakdown.tool_runs).to.equal(0.1);
    // toolRunScore(6) caps at 0.3, contribution = 0.06.
    expect(many.breakdown.tool_runs).to.equal(0.3);

    // The tool-run contribution must never equal the (pre-fix) `* 5` result
    // of 0.3 * 1.0. It now scales by baseEvidence, staying at or below 0.06.
    const delta = many.confidence - few.confidence;
    expect(delta).to.be.lessThan(0.1);
  });

  it('reports a high-confidence result under healthy factors', () => {
    const result = calculateConfidence(baseFactors());
    expect(result.level).to.equal('high');
    expect(result.confidence).to.be.greaterThan(0.7);
  });

  it('reduces confidence when code evidence is absent', () => {
    const missing = calculateConfidence(baseFactors({ codeEvidencePresent: false }));
    const present = calculateConfidence(baseFactors({ codeEvidencePresent: true }));
    expect(missing.confidence).to.be.lessThan(present.confidence);
    expect(missing.warnings).to.include('No code evidence present - confidence reduced');
  });
});