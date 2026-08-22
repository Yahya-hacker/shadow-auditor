/**
 * Patch Synthesizer — Merges competing patch proposals into a unified
 * "Super Patch" through conflict-aware synthesis.
 *
 * Algorithm:
 * 1. Sort proposals by priority: security > performance > TUI logic
 * 2. For each file, collect all hunks from all proposals
 * 3. For non-conflicting hunks: merge directly
 * 4. For conflicting hunks: apply resolution strategy
 *    - merge_both: combine both changes (imports, non-overlapping edits)
 *    - prefer_security: keep security agent's change
 *    - prefer_performance: keep performance agent's change
 *    - manual_required: mark as unresolved, include both versions commented
 * 5. Recompute line numbers for the unified diff
 * 6. Generate the final unified diff string
 */

import {
  type DiffHunk,
  type PatchConflict,
  type PatchProposal,
} from './patch-competition-schema.js';
import { parseUnifiedDiff } from './patch-conflict-detector.js';

interface HunkWithSource {
  agentRole: PatchProposal['agentRole'];
  hunk: DiffHunk;
  proposalId: string;
}

interface SynthesizedFile {
  filePath: string;
  hunks: DiffHunk[];
  newFile?: string;
  oldFile?: string;
  unresolvedConflicts: PatchConflict[];
}

interface ConflictResolutionTarget {
  conflict: PatchConflict;
  fileUnresolved: PatchConflict[];
  hunks: HunkWithSource[];
  synthesizedHunks: DiffHunk[];
}

function buildSynthesisSummary(counts: {
  accepted: number;
  files: number;
  merged: number;
  rejected: number;
  resolved: number;
  unresolved: number;
}): string {
  const parts: string[] = [];
  if (counts.accepted > 0) parts.push(`${counts.accepted} proposal(s) fully accepted`);
  if (counts.merged > 0) parts.push(`${counts.merged} proposal(s) merged`);
  if (counts.resolved > 0) parts.push(`${counts.resolved} conflict(s) auto-resolved`);
  if (counts.unresolved > 0) parts.push(`${counts.unresolved} conflict(s) require manual review`);
  if (counts.rejected > 0) parts.push(`${counts.rejected} proposal(s) rejected`);
  parts.push(`${counts.files} file(s) modified`);
  return parts.join(', ');
}

/**
 * Synthesize multiple patch proposals into a single unified diff.
 *
 * @param proposals - Array of patch proposals to merge
 * @param conflicts - Pre-detected conflicts (from detectConflicts)
 * @returns The unified diff string and metadata about the synthesis
 */
export function synthesizePatches(
  proposals: PatchProposal[],
  conflicts: PatchConflict[],
): {
  acceptedProposals: string[];
  filesModified: string[];
  mergedProposals: string[];
  rejectedProposals: string[];
  resolvedConflicts: PatchConflict[];
  summary: string;
  unifiedDiff: string;
  unresolvedConflicts: PatchConflict[];
} {
  if (proposals.length === 0) {
    return {
      acceptedProposals: [],
      filesModified: [],
      mergedProposals: [],
      rejectedProposals: [],
      resolvedConflicts: [],
      summary: 'No proposals to synthesize.',
      unifiedDiff: '',
      unresolvedConflicts: [],
    };
  }

  // Sort proposals: security first, then performance, then TUI
  const priorityOrder: Record<PatchProposal['agentRole'], number> = {
    'language_patterns': 1,
    'security_boundaries': 0,
    'tui_state_machine': 2,
  };
  const sorted = [...proposals].sort(
    (a, b) => priorityOrder[a.agentRole] - priorityOrder[b.agentRole],
  );

  // Build conflict lookup: filePath → set of conflicting proposal IDs
  const conflictMap = new Map<string, Set<string>>();
  for (const c of conflicts) {
    const existing = conflictMap.get(c.filePath) ?? new Set();
    existing.add(c.proposalAId);
    existing.add(c.proposalBId);
    conflictMap.set(c.filePath, existing);
  }

  // Collect all hunks per file, tagged with source proposal
  const fileHunks = new Map<string, HunkWithSource[]>();
  const fileHeaders = new Map<string, { newFile?: string; oldFile?: string; }>();
  for (const proposal of sorted) {
    const parsed = parseUnifiedDiff(proposal.patchDiff);
    for (const file of parsed) {
      const existing = fileHunks.get(file.filePath) ?? [];
      for (const hunk of file.hunks) {
        existing.push({
          agentRole: proposal.agentRole,
          hunk,
          proposalId: proposal.proposalId,
        });
      }

      fileHunks.set(file.filePath, existing);
      const headers = fileHeaders.get(file.filePath);
      if (
        headers &&
        (headers.oldFile !== file.oldFile || headers.newFile !== file.newFile)
      ) {
        throw new Error(`Competing patches disagree on file operation for ${file.filePath}.`);
      }

      fileHeaders.set(file.filePath, {
        newFile: file.newFile,
        oldFile: file.oldFile,
      });
    }
  }

  const resolvedConflicts: PatchConflict[] = [];
  const unresolvedConflicts: PatchConflict[] = [];
  const contributedSet = new Set<string>();
  const mergedSet = new Set<string>();
  const rejectedSet = new Set<string>();

  // Synthesize each file
  const synthesizedFiles: SynthesizedFile[] = [];
  const resolveConflict = ({
    conflict,
    fileUnresolved,
    hunks,
    synthesizedHunks,
  }: ConflictResolutionTarget): void => {
    const hunkA = hunks.find((hunk) => hunk.proposalId === conflict.proposalAId);
    const hunkB = hunks.find((hunk) => hunk.proposalId === conflict.proposalBId);
    if (conflict.resolutionStrategy === 'combine_alternating' ||
        conflict.resolutionStrategy === 'merge_both') {
      if (hunkA) {
        synthesizedHunks.push(hunkA.hunk);
        contributedSet.add(hunkA.proposalId);
        mergedSet.add(hunkA.proposalId);
      }
      if (hunkB) {
        synthesizedHunks.push(hunkB.hunk);
        contributedSet.add(hunkB.proposalId);
        mergedSet.add(hunkB.proposalId);
      }
      resolvedConflicts.push(conflict);
      return;
    }

    const preferredRole = conflict.resolutionStrategy === 'prefer_performance'
      ? 'language_patterns'
      : conflict.resolutionStrategy === 'prefer_security'
        ? 'security_boundaries'
        : undefined;
    if (preferredRole) {
      const preferredHunk = hunks.find(
        (hunk) => hunk.agentRole === preferredRole &&
          (hunk.proposalId === conflict.proposalAId || hunk.proposalId === conflict.proposalBId),
      );
      if (preferredHunk) {
        synthesizedHunks.push(preferredHunk.hunk);
        contributedSet.add(preferredHunk.proposalId);
      }

      rejectedSet.add(
        conflict.proposalAId === preferredHunk?.proposalId
          ? conflict.proposalBId
          : conflict.proposalAId,
      );
      resolvedConflicts.push(conflict);
      return;
    }

    const conflictHunk: DiffHunk = {
      header: `CONFLICT: ${conflict.conflictType} — MANUAL RESOLUTION REQUIRED`,
      lines: [
        {
          content: `<<<<<<< ${conflict.proposalAId} (${hunkA?.agentRole ?? 'unknown'})`,
          kind: 'context',
        },
        ...(hunkA?.hunk.lines ?? []).map((line) => ({...line, kind: 'context' as const})),
        {content: `=======`, kind: 'context'},
        ...(hunkB?.hunk.lines ?? []).map((line) => ({...line, kind: 'context' as const})),
        {
          content: `>>>>>>> ${conflict.proposalBId} (${hunkB?.agentRole ?? 'unknown'})`,
          kind: 'context',
        },
      ],
      newCount: conflict.overlappingRangeA.end - conflict.overlappingRangeA.start + 1,
      newStart: conflict.overlappingRangeA.start,
      oldCount: conflict.overlappingRangeA.end - conflict.overlappingRangeA.start + 1,
      oldStart: conflict.overlappingRangeA.start,
    };
    synthesizedHunks.push(conflictHunk);
    fileUnresolved.push(conflict);
    unresolvedConflicts.push(conflict);
  };

  for (const [filePath, hunks] of fileHunks) {
    const fileConflicts = conflicts.filter((c) => c.filePath === filePath);
    const fileUnresolved: PatchConflict[] = [];

    // Check if this file has conflicts
    if (fileConflicts.length === 0) {
      // No conflicts: accept all hunks, sorted by original line number
      const sortedHunks = [...hunks].sort(
        (a, b) => a.hunk.oldStart - b.hunk.oldStart,
      );

      // Recompute line numbers so merged hunks apply cleanly
      const recomputedHunks = recomputeLineNumbers(sortedHunks.map((h) => h.hunk));

      synthesizedFiles.push({
        filePath,
        hunks: recomputedHunks,
        ...fileHeaders.get(filePath),
        unresolvedConflicts: [],
      });

      for (const h of hunks) {
        contributedSet.add(h.proposalId);
      }

      continue;
    }

    // Has conflicts: resolve them
    const conflictProposalIds = conflictMap.get(filePath) ?? new Set();
    const synthesizedHunks: DiffHunk[] = [];

    for (const conflict of fileConflicts) {
      resolveConflict({conflict, fileUnresolved, hunks, synthesizedHunks});
    }

    // Add non-conflicting hunks from this file
    for (const h of hunks) {
      if (!conflictProposalIds.has(h.proposalId)) {
        synthesizedHunks.push(h.hunk);
        contributedSet.add(h.proposalId);
      }
    }

    // Sort hunks by line number for a clean diff
    synthesizedHunks.sort((a, b) => a.oldStart - b.oldStart);

    // Recompute line numbers so merged hunks from different proposals
    // apply cleanly with correct offsets.
    const recomputedHunks = recomputeLineNumbers(synthesizedHunks);

    synthesizedFiles.push({
      filePath,
      hunks: recomputedHunks,
      ...fileHeaders.get(filePath),
      unresolvedConflicts: fileUnresolved,
    });
  }

  // Generate the unified diff
  const unifiedDiff = generateUnifiedDiff(synthesizedFiles);

  // Build summary
  const filesModified = synthesizedFiles.map((f) => f.filePath);
  const contributedProposals = [...contributedSet];
  // Buckets are derived from actual synthesized-hunk provenance so a proposal
  // is classified once, accurately. A proposal that contributed content only
  // via conflict merging is "merged"; otherwise, if it contributed at all it is
  // "accepted". A proposal is "rejected" only when it lost a conflict and
  // contributed no hunks anywhere.
  const mergedProposals = [...mergedSet];
  const acceptedProposals = contributedProposals.filter((id) => !mergedSet.has(id));
  const rejectedProposals = [...rejectedSet].filter((id) => !contributedSet.has(id));

  const summary = buildSynthesisSummary({
    accepted: acceptedProposals.length,
    files: filesModified.length,
    merged: mergedProposals.length,
    rejected: rejectedProposals.length,
    resolved: resolvedConflicts.length,
    unresolved: unresolvedConflicts.length,
  });

  return {
    acceptedProposals,
    filesModified,
    mergedProposals,
    rejectedProposals,
    resolvedConflicts,
    summary,
    unifiedDiff,
    unresolvedConflicts,
  };
}

/**
 * Generate a unified diff string from synthesized file diffs.
 */
function generateUnifiedDiff(files: SynthesizedFile[]): string {
  const parts: string[] = [];

  for (const file of files) {
    const oldHeader = file.oldFile === '/dev/null'
      ? '/dev/null'
      : `a/${file.oldFile ?? file.filePath}`;
    const newHeader = file.newFile === '/dev/null'
      ? '/dev/null'
      : `b/${file.newFile ?? file.filePath}`;
    parts.push(`--- ${oldHeader}`, `+++ ${newHeader}`);

    for (const hunk of file.hunks) {
      // Hunk header
      const header = hunk.header ? ` ${hunk.header}` : '';
      parts.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${header}`);

      // Hunk body
      for (const line of hunk.lines) {
        switch (line.kind) {
          case 'added': {
            parts.push(`+${line.content}`);
            break;
          }

          case 'context': {
            parts.push(` ${line.content}`);
            break;
          }

          case 'removed': {
            parts.push(`-${line.content}`);
            break;
          }
        }
      }
    }

    parts.push(''); // Blank line between files
  }

  return parts.join('\n');
}

/**
 * Recompute line numbers for synthesized hunks so the diff applies cleanly.
 * This handles the case where hunks from different proposals are merged:
 * the line numbers must be adjusted to account for earlier insertions/deletions.
 */
export function recomputeLineNumbers(hunks: DiffHunk[]): DiffHunk[] {
  let newOffset = 0;
  const result: DiffHunk[] = [];

  for (const hunk of hunks) {
    const adjusted: DiffHunk = {
      ...hunk,
      lines: hunk.lines.map((line) => {
        const adjLine = { ...line };
        if (adjLine.newLineNumber !== undefined) {
          adjLine.newLineNumber += newOffset;
        }

        return adjLine;
      }),
      newStart: hunk.newStart + newOffset,
      oldStart: hunk.oldStart,
    };

    result.push(adjusted);

    // Update offsets for next hunk
    const addedCount = hunk.lines.filter((l) => l.kind === 'added').length;
    const removedCount = hunk.lines.filter((l) => l.kind === 'removed').length;
    newOffset += addedCount - removedCount;
  }

  return result;
}
