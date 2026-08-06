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
  const acceptedSet = new Set<string>();
  const mergedSet = new Set<string>();
  const rejectedSet = new Set<string>();

  // Synthesize each file
  const synthesizedFiles: SynthesizedFile[] = [];

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
        acceptedSet.add(h.proposalId);
      }

      continue;
    }

    // Has conflicts: resolve them
    const conflictProposalIds = conflictMap.get(filePath) ?? new Set();
    const synthesizedHunks: DiffHunk[] = [];

    for (const conflict of fileConflicts) {
      switch (conflict.resolutionStrategy) {
        case 'combine_alternating': {
          // For adjacent edits: interleave both changes
          const hunkA = hunks.find((h) => h.proposalId === conflict.proposalAId);
          const hunkB = hunks.find((h) => h.proposalId === conflict.proposalBId);
          if (hunkA) synthesizedHunks.push(hunkA.hunk);
          if (hunkB) synthesizedHunks.push(hunkB.hunk);
          resolvedConflicts.push(conflict);
          mergedSet.add(conflict.proposalAId);
          mergedSet.add(conflict.proposalBId);
          break;
        }

        case 'merge_both': {
          // Keep both hunks (e.g., both add imports)
          const hunkA = hunks.find((h) => h.proposalId === conflict.proposalAId);
          const hunkB = hunks.find((h) => h.proposalId === conflict.proposalBId);
          if (hunkA) synthesizedHunks.push(hunkA.hunk);
          if (hunkB) synthesizedHunks.push(hunkB.hunk);
          resolvedConflicts.push(conflict);
          mergedSet.add(conflict.proposalAId);
          mergedSet.add(conflict.proposalBId);
          break;
        }

        case 'prefer_performance': {
          const perfHunk = hunks.find(
            (h) => h.agentRole === 'language_patterns' &&
            (h.proposalId === conflict.proposalAId || h.proposalId === conflict.proposalBId),
          );
          if (perfHunk) {
            synthesizedHunks.push(perfHunk.hunk);
            acceptedSet.add(perfHunk.proposalId);
          }

          const otherId = conflict.proposalAId === perfHunk?.proposalId
            ? conflict.proposalBId : conflict.proposalAId;
          rejectedSet.add(otherId);
          resolvedConflicts.push(conflict);
          break;
        }

        case 'prefer_security': {
          // Keep only the security agent's hunk
          const securityHunk = hunks.find(
            (h) => h.agentRole === 'security_boundaries' &&
            (h.proposalId === conflict.proposalAId || h.proposalId === conflict.proposalBId),
          );
          if (securityHunk) {
            synthesizedHunks.push(securityHunk.hunk);
            acceptedSet.add(securityHunk.proposalId);
          }

          const otherId = conflict.proposalAId === securityHunk?.proposalId
            ? conflict.proposalBId : conflict.proposalAId;
          rejectedSet.add(otherId);
          resolvedConflicts.push(conflict);
          break;
        }

        case 'manual_required':
        default: {
          // Can't auto-resolve: include both versions as comments
          const hunkA = hunks.find((h) => h.proposalId === conflict.proposalAId);
          const hunkB = hunks.find((h) => h.proposalId === conflict.proposalBId);

          // Create a conflict marker hunk
          const conflictHunk: DiffHunk = {
            header: `CONFLICT: ${conflict.conflictType} — MANUAL RESOLUTION REQUIRED`,
            lines: [
              {
                content: `<<<<<<< ${conflict.proposalAId} (${hunkA?.agentRole ?? 'unknown'})`,
                kind: 'context',
              },
              ...(hunkA?.hunk.lines ?? []).map((l) => ({
                ...l,
                kind: 'context' as const,
              })),
              {
                content: `=======`,
                kind: 'context',
              },
              ...(hunkB?.hunk.lines ?? []).map((l) => ({
                ...l,
                kind: 'context' as const,
              })),
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
          break;
        }
      }
    }

    // Add non-conflicting hunks from this file
    for (const h of hunks) {
      if (!conflictProposalIds.has(h.proposalId)) {
        synthesizedHunks.push(h.hunk);
        acceptedSet.add(h.proposalId);
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
  const acceptedProposals = [...acceptedSet];
  const mergedProposals = [...mergedSet].filter((id) => !acceptedSet.has(id));
  const rejectedProposals = [...rejectedSet];

  const summaryParts: string[] = [];
  if (acceptedProposals.length > 0) {
    summaryParts.push(`${acceptedProposals.length} proposal(s) fully accepted`);
  }

  if (mergedProposals.length > 0) {
    summaryParts.push(`${mergedProposals.length} proposal(s) merged`);
  }

  if (resolvedConflicts.length > 0) {
    summaryParts.push(`${resolvedConflicts.length} conflict(s) auto-resolved`);
  }

  if (unresolvedConflicts.length > 0) {
    summaryParts.push(`${unresolvedConflicts.length} conflict(s) require manual review`);
  }

  if (rejectedProposals.length > 0) {
    summaryParts.push(`${rejectedProposals.length} proposal(s) rejected`);
  }

  summaryParts.push(`${filesModified.length} file(s) modified`);

  return {
    acceptedProposals,
    filesModified,
    mergedProposals,
    rejectedProposals,
    resolvedConflicts,
    summary: summaryParts.join(', '),
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
