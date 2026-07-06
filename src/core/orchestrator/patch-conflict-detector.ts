/**
 * Patch Conflict Detector — Parses unified git diffs and detects conflicts
 * between competing patch proposals from the audit swarm.
 *
 * Algorithm:
 * 1. Parse each proposal's unified diff into structured hunks (per file)
 * 2. Group proposals by affected file
 * 3. For each file with multiple proposals, compare hunk line ranges
 * 4. Classify conflicts: same_line_edit, adjacent_edit, semantic_conflict, etc.
 * 5. Assign severity and resolution strategy
 */

import * as crypto from 'node:crypto';

import {
  type DiffHunk,
  type ParsedFileDiff,
  type PatchConflict,
  type PatchProposal,
} from './patch-competition-schema.js';

/**
 * Parse a unified git diff string into structured hunks per file.
 *
 * Handles the standard unified diff format:
 *   --- a/file.ts
 *   +++ b/file.ts
 *   @@ -oldStart,oldCount +newStart,newCount @@ context
 *    context line
 *   -removed line
 *   +added line
 */
export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = diff.split('\n');

  let currentFile: ParsedFileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    // File header: --- a/path or +++ b/path
    if (line.startsWith('--- ')) {
      const filePath = line.slice(6).trim().replace(/^[ab]\//, '');
      if (!currentFile) {
        currentFile = {
          filePath,
          hunks: [],
          linesAdded: 0,
          linesRemoved: 0,
        };
      } else {
        currentFile.oldFile = filePath;
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const filePath = line.slice(6).trim().replace(/^[ab]\//, '');
      if (currentFile) {
        currentFile.newFile = filePath;
        // Use the new file path as the canonical path
        currentFile.filePath = filePath;
      }
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ context
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/);
    if (hunkMatch && currentFile) {
      // Save previous hunk
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const oldStart = parseInt(hunkMatch[1]!, 10);
      const oldCount = parseInt(hunkMatch[2] ?? '1', 10);
      const newStart = parseInt(hunkMatch[3]!, 10);
      const newCount = parseInt(hunkMatch[4] ?? '1', 10);
      const header = hunkMatch[5]?.trim() ?? '';

      oldLineNum = oldStart;
      newLineNum = newStart;

      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        header,
        lines: [],
      };
      continue;
    }

    // Hunk body lines
    if (currentHunk && currentFile) {
      if (line.startsWith('-')) {
        currentHunk.lines.push({
          kind: 'removed',
          content: line.slice(1),
          oldLineNumber: oldLineNum,
        });
        currentFile.linesRemoved++;
        oldLineNum++;
      } else if (line.startsWith('+')) {
        currentHunk.lines.push({
          kind: 'added',
          content: line.slice(1),
          newLineNumber: newLineNum,
        });
        currentFile.linesAdded++;
        newLineNum++;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({
          kind: 'context',
          content: line.startsWith(' ') ? line.slice(1) : line,
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
        });
        oldLineNum++;
        newLineNum++;
      }
      // Lines starting with \ (e.g., "\ No newline at end of file") are ignored
    }
  }

  // Save last hunk and file
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Get the effective line range affected by a hunk in the ORIGINAL file.
 * Returns { start, end } where start is the first modified line and end is the last.
 */
function hunkOriginalRange(hunk: DiffHunk): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;

  for (const line of hunk.lines) {
    if (line.oldLineNumber !== undefined) {
      start = Math.min(start, line.oldLineNumber);
      end = Math.max(end, line.oldLineNumber);
    }
  }

  return {
    start: start === Infinity ? hunk.oldStart : start,
    end: end === -Infinity ? hunk.oldStart + hunk.oldCount - 1 : end,
  };
}

/**
 * Check if two line ranges overlap or are adjacent.
 * Returns the overlap range if they do, null otherwise.
 * Adjacent = within 3 lines of each other (order sensitivity).
 */
function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): { start: number; end: number } | 'adjacent' | null {
  const gap = Math.max(a.start, b.start) - Math.min(a.end, b.end);

  if (gap <= 0) {
    // Overlapping: actual overlap
    return {
      start: Math.max(a.start, b.start),
      end: Math.min(a.end, b.end),
    };
  }

  if (gap <= 3) {
    // Adjacent: within 3 lines
    return 'adjacent';
  }

  return null; // No conflict
}

/**
 * Classify the conflict type based on the overlapping hunks.
 */
function classifyConflict(
  hunkA: DiffHunk,
  hunkB: DiffHunk,
  filePath: string,
): PatchConflict['conflictType'] {
  const linesA = hunkA.lines.filter((l) => l.kind !== 'context');
  const linesB = hunkB.lines.filter((l) => l.kind !== 'context');

  // Check if both hunks modify the exact same lines
  const aRemoved = new Set(linesA.filter((l) => l.kind === 'removed').map((l) => l.content.trim()));
  const bRemoved = new Set(linesB.filter((l) => l.kind === 'removed').map((l) => l.content.trim()));

  const sameRemoved = [...aRemoved].some((l) => bRemoved.has(l));
  if (sameRemoved) return 'same_line_edit';

  // Check if the conflict is in imports/headers
  const isImportArea = filePath.endsWith('.ts') || filePath.endsWith('.tsx') ||
    filePath.endsWith('.js') || filePath.endsWith('.jsx') ||
    filePath.endsWith('.py') || filePath.endsWith('.go');

  if (isImportArea) {
    const allContent = [...linesA, ...linesB].map((l) => l.content).join(' ');
    if (allContent.includes('import ') || allContent.includes('from ') ||
        allContent.includes('require(') || allContent.includes('use ')) {
      return 'import_header_conflict';
    }
  }

  // Check if both modify test files
  if (filePath.includes('.test.') || filePath.includes('.spec.') ||
      filePath.includes('__tests__') || filePath.includes('/test/')) {
    return 'test_conflict';
  }

  return 'adjacent_edit';
}

/**
 * Determine the auto-resolution strategy for a conflict.
 */
function determineResolutionStrategy(
  conflictType: PatchConflict['conflictType'],
  proposalA: PatchProposal,
  proposalB: PatchProposal,
): PatchConflict['resolutionStrategy'] {
  // Security always wins unless the other proposal explicitly improves security
  if (proposalA.agentRole === 'security_boundaries' &&
      proposalB.agentRole !== 'security_boundaries') {
    return 'prefer_security';
  }
  if (proposalB.agentRole === 'security_boundaries' &&
      proposalA.agentRole !== 'security_boundaries') {
    return 'prefer_security';
  }

  switch (conflictType) {
    case 'import_header_conflict':
      return 'merge_both'; // Can usually combine imports
    case 'adjacent_edit':
      return 'combine_alternating'; // Can interleave if non-overlapping
    case 'same_line_edit':
      return 'manual_required'; // Must have human decision
    case 'test_conflict':
      return 'merge_both'; // Combine test changes
    default:
      return 'manual_required';
  }
}

/**
 * Detect all conflicts between a set of patch proposals.
 *
 * @returns Array of PatchConflict objects describing every detected conflict.
 */
export function detectConflicts(proposals: PatchProposal[]): PatchConflict[] {
  if (proposals.length < 2) return [];

  const conflicts: PatchConflict[] = [];

  // Parse all proposals into structured diffs
  const parsed = proposals.map((p) => ({
    proposal: p,
    files: parseUnifiedDiff(p.patchDiff),
  }));

  // Group by file path
  const fileProposals = new Map<string, Array<{ proposal: PatchProposal; files: ParsedFileDiff[] }>>();
  for (const { proposal, files } of parsed) {
    for (const file of files) {
      const existing = fileProposals.get(file.filePath) ?? [];
      existing.push({ proposal, files: [file] });
      fileProposals.set(file.filePath, existing);
    }
  }

  // For each file with multiple proposals, check for conflicts
  for (const [filePath, entries] of fileProposals) {
    if (entries.length < 2) continue;

    // Compare each pair of proposals for this file
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const entryA = entries[i]!;
        const entryB = entries[j]!;
        const fileDiffA = entryA.files.find((f) => f.filePath === filePath);
        const fileDiffB = entryB.files.find((f) => f.filePath === filePath);
        if (!fileDiffA || !fileDiffB) continue;

        // Compare hunks
        for (const hunkA of fileDiffA.hunks) {
          const rangeA = hunkOriginalRange(hunkA);

          for (const hunkB of fileDiffB.hunks) {
            const rangeB = hunkOriginalRange(hunkB);
            const overlap = rangesOverlap(rangeA, rangeB);

            if (overlap === null) continue; // No conflict

            const conflictType = classifyConflict(hunkA, hunkB, filePath);
            const severity: PatchConflict['severity'] =
              conflictType === 'same_line_edit' ? 'blocking' :
              overlap === 'adjacent' ? 'warning' : 'warning';

            conflicts.push({
              conflictId: `conflict_${crypto.randomBytes(6).toString('hex')}`,
              filePath,
              proposalAId: entryA.proposal.proposalId,
              proposalBId: entryB.proposal.proposalId,
              overlappingRangeA: rangeA,
              overlappingRangeB: rangeB,
              hunkA: hunkA.lines.map((l) => `${l.kind === 'removed' ? '-' : l.kind === 'added' ? '+' : ' '}${l.content}`).join('\n'),
              hunkB: hunkB.lines.map((l) => `${l.kind === 'removed' ? '-' : l.kind === 'added' ? '+' : ' '}${l.content}`).join('\n'),
              severity,
              conflictType,
              description: buildConflictDescription(conflictType, filePath, entryA.proposal, entryB.proposal),
              resolutionStrategy: determineResolutionStrategy(conflictType, entryA.proposal, entryB.proposal),
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * Build a human-readable description of the conflict.
 */
function buildConflictDescription(
  conflictType: PatchConflict['conflictType'],
  filePath: string,
  proposalA: PatchProposal,
  proposalB: PatchProposal,
): string {
  switch (conflictType) {
    case 'same_line_edit':
      return `Both ${proposalA.agentRole} and ${proposalB.agentRole} modified the same lines in ${filePath}. ` +
        `Manual resolution required: decide which edit to keep, or merge the changes.`;
    case 'adjacent_edit':
      return `${proposalA.agentRole} and ${proposalB.agentRole} edited adjacent lines in ${filePath}. ` +
        `Changes can likely be combined but verify ordering.`;
    case 'semantic_conflict':
      return `${proposalA.agentRole} and ${proposalB.agentRole} made semantically conflicting changes to ${filePath}. ` +
        `While the text diffs don't overlap, the logic may be incompatible.`;
    case 'import_header_conflict':
      return `Both proposals modified imports in ${filePath}. ` +
        `These can usually be merged by combining both import sets.`;
    case 'test_conflict':
      return `Both proposals modified the same test in ${filePath}. ` +
        `Combine test cases to cover both scenarios.`;
    default:
      return `Conflict detected between ${proposalA.agentRole} and ${proposalB.agentRole} in ${filePath}.`;
  }
}

/**
 * Compute a deterministic hash of the original state (pre-patch).
 * Used for idempotency: re-running the same proposals on the same state
 * yields the same conflict detection results.
 */
export function computeBaseStateHash(files: Map<string, string>): string {
  const entries = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `${path}:${content.length}:${crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)}`)
    .join('|');

  return crypto.createHash('sha256').update(entries).digest('hex').slice(0, 16);
}
