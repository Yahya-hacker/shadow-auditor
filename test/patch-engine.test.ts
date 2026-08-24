import { expect } from 'chai';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PatchConflict, PatchProposal } from '../src/core/orchestrator/patch-competition-schema.js';

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

  it('classifies proposals into disjoint accepted/merged/rejected buckets (#6)', () => {
    // The #6 bug: a proposal that LOSES a conflict in one file yet still
    // contributes content elsewhere was double-counted as both "accepted" and
    // "rejected". Any proposal that contributes at all must never be reported
    // as rejected, and the three buckets must be disjoint.
    const file1 = ['--- a/file1.ts', '+++ b/file1.ts', '@@ -1,1 +1,1 @@', '-a', '+A'].join('\n');
    const file2 = ['--- a/file2.ts', '+++ b/file2.ts', '@@ -10,1 +10,1 @@', '-x', '+X'].join('\n');
    const file3 = ['--- a/file3.ts', '+++ b/file3.ts', '@@ -5,1 +5,1 @@', '-b', '+B'].join('\n');
    const file4 = ['--- a/file4.ts', '+++ b/file4.ts', '@@ -7,1 +7,1 @@', '-c', '+C'].join('\n');

    // A wins a prefer_security conflict in file1 and contributes alone in file2.
    const propA = proposal([file1, file2].join('\n'));
    propA.proposalId = 'A';
    propA.agentRole = 'security_boundaries';

    // B LOSES the file1 conflict to A but contributes alone in file3 => accepted,
    // and crucially NOT rejected even though rejectedSet contains it.
    const propB = proposal([file1, file3].join('\n'));
    propB.proposalId = 'B';
    propB.agentRole = 'tui_state_machine';

    // C and D are merged together via merge_both in file4.
    const propC = proposal(file4);
    propC.proposalId = 'C';
    propC.agentRole = 'language_patterns';
    const propD = proposal(file4);
    propD.proposalId = 'D';
    propD.agentRole = 'tui_state_machine';

    const conflicts: PatchConflict[] = [
      {
        conflictId: 'c1',
        conflictType: 'same_line_edit',
        description: 'A vs B edit same line',
        filePath: 'file1.ts',
        hunkA: '-a\n+A',
        hunkB: '-a\n+B',
        overlappingRangeA: { end: 1, start: 1 },
        overlappingRangeB: { end: 1, start: 1 },
        proposalAId: 'A',
        proposalBId: 'B',
        resolutionStrategy: 'prefer_security',
        severity: 'warning',
      },
      {
        conflictId: 'c2',
        conflictType: 'same_line_edit',
        description: 'C vs D edit same line',
        filePath: 'file4.ts',
        hunkA: '-c\n+C',
        hunkB: '-c\n+D',
        overlappingRangeA: { end: 7, start: 7 },
        overlappingRangeB: { end: 7, start: 7 },
        proposalAId: 'C',
        proposalBId: 'D',
        resolutionStrategy: 'merge_both',
        severity: 'warning',
      },
    ];

    const result = synthesizePatches([propA, propB, propC, propD], conflicts);

    // A wins its conflict => accepted; B loses but still contributes => accepted.
    expect(result.acceptedProposals).to.have.members(['A', 'B']);
    // C and D are merged in file4 => both merged, neither accepted.
    expect(result.mergedProposals).to.have.members(['C', 'D']);
    expect(result.acceptedProposals).to.not.include.any.members(['C', 'D']);
    // No proposal is rejected: every one contributed content somewhere.
    expect(result.rejectedProposals).to.deep.equal([]);
    // Disjointness: each proposal appears in exactly one of the three buckets.
    const inAccepted = new Set(result.acceptedProposals);
    const inMerged = new Set(result.mergedProposals);
    const inRejected = new Set(result.rejectedProposals);
    for (const id of [...result.acceptedProposals, ...result.mergedProposals, ...result.rejectedProposals]) {
      const count = Number(inAccepted.has(id)) + Number(inMerged.has(id)) + Number(inRejected.has(id));
      expect(count, `proposal ${id} must be in exactly one bucket`).to.equal(1);
    }

    // Every proposal is accounted for exactly once.
    expect([...new Set([...result.acceptedProposals, ...result.mergedProposals, ...result.rejectedProposals])].sort())
      .to.deep.equal(['A', 'B', 'C', 'D']);
  });

  it('synthesized multi-proposal patches apply cleanly via real git apply', async () => {
    const tmpDir = await mkdtemp(tmpdir() + '/sa-patch-');
    try {
      const file = join(tmpDir, 'lf.ts');
      await writeFile(
        file,
        ['a','b','c','d','e','f','g','h','i','j','old','k'].join('\n') + '\n',
        'utf8',
      );

      // Proposal A removes lines e,f. Proposal B changes line 'old'.
      const diffA = [
        '--- a/lf.ts', '+++ b/lf.ts', '@@ -4,4 +4,2 @@', ' d', '-e', '-f', ' g',
      ].join('\n');
      const diffB = [
        '--- a/lf.ts', '+++ b/lf.ts', '@@ -10,3 +10,3 @@', ' j', '-old', '+new', ' k',
      ].join('\n');

      const result = synthesizePatches(
        [proposal(diffA), proposal(diffB)],
        [],
      );

      // Apply the synthesized diff with the real production command.
      await new Promise<void>((resolve, reject) => {
        const child = spawn('git', ['apply', '--whitespace=nowarn', '-'], {
          cwd: tmpDir,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => { stderr += c; });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`git apply failed: ${stderr}`));
        });
        child.stdin.end(result.unifiedDiff);
      });

      const applied = await readFile(file, 'utf8');
      const lines = applied.replaceAll('\r', '').split('\n');
      expect(lines).to.include.members(['a','d','g','h','i','j','new']);
      expect(lines).to.not.include('old');
      expect(lines).to.not.include('e');
      expect(lines).to.not.include('f');
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });
});
