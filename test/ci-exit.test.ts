import { expect } from 'chai';

import type { SecurityFinding } from '../src/core/output/report-schema.js';

import { computeCiExitCode, formatCiSummary } from '../src/core/output/ci-exit.js';

function makeFinding(sev: SecurityFinding['severity_label'], id = 'SHADOW-001'): SecurityFinding {
  return {
    cvss_v31_score: 7,
    cvss_v31_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
    cvss_v40_score: null,
    cwe: 'CWE-89',
    file_paths: ['src/app.ts'],
    severity_label: sev,
    title: `Finding ${id}`,
    vuln_id: id,
  };
}

describe('ci-exit', () => {
  describe('computeCiExitCode', () => {
    it('exits 0 when there are no findings', () => {
      const result = computeCiExitCode({ failOn: 'high', findings: [] });
      expect(result.code).to.equal(0);
      expect(result.triggeringFindings).to.have.length(0);
    });

    it('exits 0 when no findings meet the threshold (low findings, fail-on high)', () => {
      const result = computeCiExitCode({
        failOn: 'high',
        findings: [makeFinding('Low'), makeFinding('Medium')],
      });
      expect(result.code).to.equal(0);
    });

    it('exits 1 when a High finding exists and fail-on is high', () => {
      const result = computeCiExitCode({
        failOn: 'high',
        findings: [makeFinding('High')],
      });
      expect(result.code).to.equal(1);
      expect(result.triggeringFindings).to.have.length(1);
    });

    it('exits 1 when a Critical finding exists and fail-on is high', () => {
      const result = computeCiExitCode({
        failOn: 'high',
        findings: [makeFinding('Critical')],
      });
      expect(result.code).to.equal(1);
    });

    it('exits 0 when a High finding exists but fail-on is critical', () => {
      const result = computeCiExitCode({
        failOn: 'critical',
        findings: [makeFinding('High')],
      });
      expect(result.code).to.equal(0);
    });

    it('exits 1 when fail-on is low and any finding exists', () => {
      const result = computeCiExitCode({
        failOn: 'low',
        findings: [makeFinding('Low')],
      });
      expect(result.code).to.equal(1);
    });

    it('always exits 0 when fail-on is none', () => {
      const result = computeCiExitCode({
        failOn: 'none',
        findings: [makeFinding('Critical'), makeFinding('High')],
      });
      expect(result.code).to.equal(0);
    });

    it('defaults to fail-on high when not specified', () => {
      const result = computeCiExitCode({ findings: [makeFinding('High')] });
      expect(result.code).to.equal(1);
    });

    it('includes only triggering findings in the result', () => {
      const result = computeCiExitCode({
        failOn: 'high',
        findings: [makeFinding('Low', 'SHADOW-001'), makeFinding('High', 'SHADOW-002'), makeFinding('Critical', 'SHADOW-003')],
      });
      expect(result.triggeringFindings.map((f) => f.vuln_id)).to.have.members(['SHADOW-002', 'SHADOW-003']);
    });

    it('includes a human-readable message', () => {
      const result = computeCiExitCode({ failOn: 'high', findings: [makeFinding('High')] });
      expect(result.message).to.include('high');
    });
  });

  describe('formatCiSummary', () => {
    it('shows PASS status when exit code is 0', () => {
      const result = computeCiExitCode({ failOn: 'high', findings: [] });
      const summary = formatCiSummary(result, 'high');
      expect(summary).to.include('PASS');
    });

    it('shows FAIL status when exit code is 1', () => {
      const result = computeCiExitCode({ failOn: 'high', findings: [makeFinding('High')] });
      const summary = formatCiSummary(result, 'high');
      expect(summary).to.include('FAIL');
    });

    it('lists triggering findings in the summary', () => {
      const result = computeCiExitCode({ failOn: 'high', findings: [makeFinding('High', 'SHADOW-007')] });
      const summary = formatCiSummary(result, 'high');
      expect(summary).to.include('SHADOW-007');
    });
  });
});
