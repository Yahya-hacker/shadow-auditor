import { expect } from 'chai';

import type { SecurityFinding } from '../src/core/output/report-schema.js';

import { deduplicateFindings, highestSeverity } from '../src/core/output/dedup.js';

function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    cvss_v31_score: 7.5,
    cvss_v31_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
    cvss_v40_score: null,
    cwe: 'CWE-89',
    file_paths: ['src/db/query.ts'],
    severity_label: 'High',
    title: 'SQL injection through string concatenation',
    vuln_id: 'SHADOW-089-AABBCCDD',
    ...overrides,
  };
}

describe('dedup', () => {
  describe('deduplicateFindings', () => {
    it('returns an empty array for empty input', () => {
      expect(deduplicateFindings([])).to.deep.equal([]);
    });

    it('keeps a single unique finding unchanged (except stable vuln_id)', () => {
      const result = deduplicateFindings([makeFinding()]);
      expect(result).to.have.length(1);
      expect(result[0].cwe).to.equal('CWE-89');
    });

    it('deduplicates two identical findings into one', () => {
      const f = makeFinding();
      const result = deduplicateFindings([f, { ...f }]);
      expect(result).to.have.length(1);
    });

    it('merges file paths from duplicate findings', () => {
      const f1 = makeFinding({ file_paths: ['src/db/query.ts'] });
      const f2 = makeFinding({ file_paths: ['src/db/search.ts'] });
      const result = deduplicateFindings([f1, f2]);
      expect(result).to.have.length(1);
      expect(result[0].file_paths).to.include('src/db/query.ts');
      expect(result[0].file_paths).to.include('src/db/search.ts');
    });

    it('keeps separate findings for different CWEs', () => {
      const f1 = makeFinding({ cwe: 'CWE-89' });
      const f2 = makeFinding({ cwe: 'CWE-79', title: 'XSS', vuln_id: 'SHADOW-079-EEFFGGHH' });
      const result = deduplicateFindings([f1, f2]);
      expect(result).to.have.length(2);
    });

    it('keeps separate findings for different titles (different root cause)', () => {
      const f1 = makeFinding({ title: 'SQL injection in login' });
      const f2 = makeFinding({ title: 'SQL injection in search', vuln_id: 'SHADOW-089-XXXX' });
      const result = deduplicateFindings([f1, f2]);
      expect(result).to.have.length(2);
    });

    it('produces deterministic vuln_id for merged finding', () => {
      const f1 = makeFinding({ file_paths: ['src/db/query.ts'] });
      const f2 = makeFinding({ file_paths: ['src/db/query.ts'] });
      const r1 = deduplicateFindings([f1, f2]);
      const r2 = deduplicateFindings([f2, f1]);
      expect(r1[0].vuln_id).to.equal(r2[0].vuln_id);
    });

    it('sorts results by vuln_id for deterministic ordering', () => {
      const findings = [
        makeFinding({ cwe: 'CWE-89', file_paths: ['z.ts'], title: 'SQL injection' }),
        makeFinding({ cwe: 'CWE-22', file_paths: ['a.ts'], title: 'Path traversal' }),
      ];
      const result = deduplicateFindings(findings);
      // Result should be sorted ascending by vuln_id
      const ids = result.map((f) => f.vuln_id);
      expect(ids).to.deep.equal([...ids].sort());
    });

    it('picks the higher CVSS score when merging duplicates', () => {
      const f1 = makeFinding({ cvss_v31_score: 6 });
      const f2 = makeFinding({ cvss_v31_score: 9 });
      const result = deduplicateFindings([f1, f2]);
      expect(result).to.have.length(1);
      expect(result[0].cvss_v31_score).to.equal(9);
    });
  });

  describe('highestSeverity', () => {
    it('returns null for empty findings', () => {
      expect(highestSeverity([])).to.be.null;
    });

    it('returns the highest severity in the list', () => {
      const findings = [
        makeFinding({ severity_label: 'Low' }),
        makeFinding({ severity_label: 'Critical' }),
        makeFinding({ severity_label: 'Medium' }),
      ];
      expect(highestSeverity(findings)).to.equal('Critical');
    });

    it('returns single finding severity correctly', () => {
      expect(highestSeverity([makeFinding({ severity_label: 'Medium' })])).to.equal('Medium');
    });
  });
});
