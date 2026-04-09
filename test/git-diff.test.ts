import { expect } from 'chai';

import type { ChangedFilesResult } from '../src/core/tools/git-diff.js';

import { buildDiffScopeHint } from '../src/core/tools/git-diff.js';

describe('git-diff', () => {
  describe('buildDiffScopeHint', () => {
    it('returns an empty string when usedFallback is true', () => {
      const result: ChangedFilesResult = {
        files: ['src/app.ts'],
        resolvedRef: 'HEAD~1',
        usedFallback: true,
      };
      expect(buildDiffScopeHint(result)).to.equal('');
    });

    it('returns an empty string when no files changed', () => {
      const result: ChangedFilesResult = {
        files: [],
        resolvedRef: 'abc123',
        usedFallback: false,
      };
      expect(buildDiffScopeHint(result)).to.equal('');
    });

    it('returns a non-empty hint when files are changed', () => {
      const result: ChangedFilesResult = {
        files: ['src/auth.ts', 'src/db.ts'],
        resolvedRef: 'abc123456def',
        usedFallback: false,
      };
      const hint = buildDiffScopeHint(result);
      expect(hint).to.include('src/auth.ts');
      expect(hint).to.include('src/db.ts');
      expect(hint).to.include('abc123456def');
    });

    it('includes the base ref in the hint text', () => {
      const result: ChangedFilesResult = {
        files: ['src/app.ts'],
        resolvedRef: 'deadbeef1234',
        usedFallback: false,
      };
      const hint = buildDiffScopeHint(result);
      expect(hint).to.include('deadbeef1234');
    });
  });
});
