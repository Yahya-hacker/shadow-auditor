import { expect } from 'chai';

import type { PatchProposal } from '../src/core/orchestrator/patch-competition-schema.js';

import { parseUnifiedDiff } from '../src/core/orchestrator/patch-conflict-detector.js';
import { verifySynthesizedPatch } from '../src/core/orchestrator/patch-logical-verifier.js';
import {
  recomputeLineNumbers,
  synthesizePatches,
} from '../src/core/orchestrator/patch-synthesizer.js';

function proposal(patchDiff: string): PatchProposal {
  return {
    agentRole: 'security_boundaries',
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    filesAffected: ['new.ts'],
    metadata: {},
    patchDiff,
    proposalId: 'patch1',
    rationale: 'Secure the affected implementation.',
    severity: 'high',
    targetLanguage: 'typescript',
    vulnerabilityType: 'CWE-20',
  };
}

describe('patch engine integrity', () => {
  it('parses every file in a multi-file patch', () => {
    const parsed = parseUnifiedDiff([
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+ONE',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -1,1 +1,1 @@',
      '-two',
      '+TWO',
    ].join('\n'));

    expect(parsed.map((file) => file.filePath)).to.deep.equal(['one.ts', 'two.ts']);
    expect(parsed[0]?.hunks).to.have.length(1);
    expect(parsed[1]?.hunks).to.have.length(1);
  });

  it('rejects text that is not a unified diff', () => {
    const report = verifySynthesizedPatch('This patch looks secure.');
    expect(report.overallVerdict).to.equal('rejected');
  });

  it('does not shift old-file coordinates after an earlier insertion', () => {
    const hunks = parseUnifiedDiff([
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,0 +1,1 @@',
      '+first',
      '@@ -10,1 +11,1 @@',
      '-old',
      '+new',
    ].join('\n'))[0]!.hunks;
    const adjusted = recomputeLineNumbers(hunks);

    expect(adjusted[1]?.oldStart).to.equal(10);
    expect(adjusted[1]?.newStart).to.equal(12);
  });

  it('preserves file creation headers during synthesis', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+export const secure = true;',
    ].join('\n');
    const result = synthesizePatches([proposal(diff)], []);

    expect(result.unifiedDiff).to.include('--- /dev/null\n+++ b/new.ts');
  });
});
