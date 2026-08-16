/**
 * Finding Deduplication and Grouping
 *
 * Groups multiple occurrences (locations) of the same root-cause vulnerability
 * under a single canonical finding, merges evidence and locations
 * deterministically, and avoids SARIF rule/result spam.
 */

import type { SecurityFinding } from './report-schema.js';

import { computeRootCauseFingerprint, computeVulnId } from './vuln-fingerprint.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a grouping key that ignores file paths so findings with the same
 * CWE and title in different files are merged under one canonical finding.
 */
function groupingKey(cwe: string, title: string): string {
  return computeRootCauseFingerprint({ cwe, filePaths: [], title });
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FindingGroup {
  /** All file paths accumulated across occurrences */
  filePaths: Set<string>;
  /** The representative finding */
  primary: SecurityFinding;
  /** Root-cause fingerprint (used as group key) */
  rootCauseKey: string;
  /**
   * Stable vuln_id frozen from the FIRST-SEEN primary's own file paths.
   *
   * The ID is captured once when the group is created, not recomputed at output
   * time. Recomputing from `group.primary.file_paths` was the bug: when a
   * higher-CVSS occurrence from a *different* file later replaces `primary`,
   * the recomputed ID would silently change, so the same logical vulnerability
   * got a different ID depending on which files/results were present — breaking
   * the "stable across reruns" promise. Freezing at first-seen keeps the ID
   * stable both under file-path growth and under primary swaps.
   */
  vulnId: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deduplicate and group an array of security findings.
 *
 * Findings with the same root-cause fingerprint (same CWE + normalised title
 * + primary file) are merged into a single finding whose `file_paths` is the
 * union of all affected files and whose `vuln_id` is recomputed to be stable.
 *
 * The resulting array is sorted by `vuln_id` for deterministic SARIF output.
 */
export function deduplicateFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const groups = new Map<string, FindingGroup>();

  for (const finding of findings) {
    // Group by CWE + title + primary file path. Same CWE+title in
    // different files may be independent instances of the same vulnerability
    // class; we merge them but preserve all affected file paths below.
    const key = groupingKey(finding.cwe, finding.title);

    const existing = groups.get(key);
    if (existing) {
      // Merge file paths
      for (const fp of finding.file_paths) {
        existing.filePaths.add(fp);
      }

      // Keep the higher CVSS score as the representative. The vuln_id stays
            // stable regardless because it was frozen on group creation (first-seen).
      if ((finding.cvss_v31_score ?? 0) > (existing.primary.cvss_v31_score ?? 0)) {
        existing.primary = { ...finding };
      }
    } else {
      groups.set(key, {
        filePaths: new Set(finding.file_paths),
        primary: finding,
        rootCauseKey: key,
        // Freeze the ID computed from the occurrence that seeds the group.
        // Computed fresh (ignoring any caller-supplied vuln_id) so the ID is
        // deterministic, and frozen so a later higher-CVSS primary from a
        // different file can't change it.
        vulnId: computeVulnId({
          cwe: finding.cwe,
          filePaths: finding.file_paths,
          title: finding.title,
        }),
      });
    }
  }

  const deduped: SecurityFinding[] = [];

  for (const group of groups.values()) {
    // Deterministic file path ordering
    const sortedPaths = [...group.filePaths].sort();

    // Use the frozen first-seen vuln_id so the merged finding's ID is stable
    // regardless of which occurrence became the representative.
    deduped.push({
      ...group.primary,
      file_paths: sortedPaths,
      vuln_id: group.vulnId,
    });
  }

  // Sort by vuln_id for deterministic SARIF output
  return deduped.sort((a, b) => a.vuln_id.localeCompare(b.vuln_id));
}

/**
 * Return the severity level that represents the highest risk among the given
 * findings. Returns `null` when the array is empty.
 */
export function highestSeverity(
  findings: SecurityFinding[],
): null | SecurityFinding['severity_label'] {
  if (findings.length === 0) {
    return null;
  }

  const order: Record<SecurityFinding['severity_label'], number> = {
    Critical: 5,
    High: 4,
    Info: 1,
    Low: 2,
    Medium: 3,
  };

  let best = findings[0];
  for (const f of findings.slice(1)) {
    if (order[f.severity_label] > order[best.severity_label]) {
      best = f;
    }
  }

  return best.severity_label;
}
