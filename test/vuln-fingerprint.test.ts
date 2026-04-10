import { expect } from 'chai';

import { computeRootCauseFingerprint, computeVulnId } from '../src/core/output/vuln-fingerprint.js';

describe('vuln-fingerprint', () => {
  describe('computeVulnId', () => {
    it('produces the same ID for identical inputs (deterministic)', () => {
      const input = {
        cwe: 'CWE-89',
        filePaths: ['src/db/query.ts'],
        lineNumbers: [42, 55],
        symbolName: 'buildQuery',
        title: 'SQL injection through string concatenation',
      };
      const id1 = computeVulnId(input);
      const id2 = computeVulnId(input);
      expect(id1).to.equal(id2);
    });

    it('produces SHADOW-<CWE>-<HEX8> format', () => {
      const id = computeVulnId({
        cwe: 'CWE-89',
        filePaths: ['src/db/query.ts'],
        title: 'SQL injection',
      });
      expect(id).to.match(/^SHADOW-\d{3}-[A-F0-9]{8}$/);
    });

    it('pads CWE number to 3 digits', () => {
      const id = computeVulnId({ cwe: 'CWE-79', title: 'XSS' });
      expect(id).to.match(/^SHADOW-079-/);
    });

    it('produces different IDs for different CWEs', () => {
      const base = { filePaths: ['src/app.ts'], title: 'Injection' };
      const id1 = computeVulnId({ ...base, cwe: 'CWE-89' });
      const id2 = computeVulnId({ ...base, cwe: 'CWE-79' });
      expect(id1).to.not.equal(id2);
    });

    it('produces different IDs for different titles', () => {
      const base = { cwe: 'CWE-89', filePaths: ['src/app.ts'] };
      const id1 = computeVulnId({ ...base, title: 'SQL injection in login' });
      const id2 = computeVulnId({ ...base, title: 'SQL injection in search' });
      expect(id1).to.not.equal(id2);
    });

    it('produces different IDs for different primary files', () => {
      const base = { cwe: 'CWE-89', title: 'SQL injection' };
      const id1 = computeVulnId({ ...base, filePaths: ['src/auth.ts'] });
      const id2 = computeVulnId({ ...base, filePaths: ['src/search.ts'] });
      expect(id1).to.not.equal(id2);
    });

    it('normalizes line number order for stability', () => {
      const base = { cwe: 'CWE-89', filePaths: ['src/app.ts'], title: 'SQL injection' };
      const id1 = computeVulnId({ ...base, lineNumbers: [10, 20, 30] });
      const id2 = computeVulnId({ ...base, lineNumbers: [30, 10, 20] });
      expect(id1).to.equal(id2);
    });

    it('normalizes Windows-style file paths to POSIX', () => {
      const id1 = computeVulnId({ cwe: 'CWE-89', filePaths: [String.raw`src\db\query.ts`], title: 'SQL injection' });
      const id2 = computeVulnId({ cwe: 'CWE-89', filePaths: ['src/db/query.ts'], title: 'SQL injection' });
      expect(id1).to.equal(id2);
    });

    it('works without optional fields', () => {
      const id = computeVulnId({ cwe: 'CWE-798', title: 'Hardcoded credentials' });
      expect(id).to.match(/^SHADOW-798-[A-F0-9]{8}$/);
    });
  });

  describe('computeRootCauseFingerprint', () => {
    it('returns the same fingerprint for same CWE+title+file', () => {
      const input = { cwe: 'CWE-79', filePaths: ['src/render.tsx'], title: 'Reflected XSS' };
      expect(computeRootCauseFingerprint(input)).to.equal(computeRootCauseFingerprint(input));
    });

    it('ignores line numbers (broader grouping)', () => {
      const base = { cwe: 'CWE-79', filePaths: ['src/render.tsx'], title: 'Reflected XSS' };
      const fp1 = computeRootCauseFingerprint({ ...base, lineNumbers: [10] });
      const fp2 = computeRootCauseFingerprint({ ...base, lineNumbers: [99] });
      expect(fp1).to.equal(fp2);
    });

    it('ignores symbol name (broader grouping)', () => {
      const base = { cwe: 'CWE-79', filePaths: ['src/render.tsx'], title: 'Reflected XSS' };
      const fp1 = computeRootCauseFingerprint({ ...base, symbolName: 'renderA' });
      const fp2 = computeRootCauseFingerprint({ ...base, symbolName: 'renderB' });
      expect(fp1).to.equal(fp2);
    });

    it('differs for different CWEs', () => {
      const base = { filePaths: ['src/app.ts'], title: 'Injection' };
      expect(computeRootCauseFingerprint({ ...base, cwe: 'CWE-89' })).to.not.equal(
        computeRootCauseFingerprint({ ...base, cwe: 'CWE-79' }),
      );
    });
  });
});
