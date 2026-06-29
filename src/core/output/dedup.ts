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
// Internal types
// ---------------------------------------------------------------------------

interface FindingGroup {
  /** All file paths accumulated across occurrences */
  filePaths: Set<string>;
  /** The representative (first-seen) finding */
  primary: SecurityFinding;
  /** Root-cause fingerprint (used as group key) */
  rootCauseKey: string;
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
    const key = computeRootCauseFingerprint({
      cwe: finding.cwe,
      // Root-cause fingerprint intentionally excludes file paths:
      // same CWE + same title = same root cause even across different files.
      title: finding.title,
    });

    const existing = groups.get(key);
    if (existing) {
      // Merge file paths
      for (const fp of finding.file_paths) {
        existing.filePaths.add(fp);
      }

      // Keep the higher CVSS score as representative
      if ((finding.cvss_v31_score ?? 0) > (existing.primary.cvss_v31_score ?? 0)) {
        existing.primary = { ...finding, file_paths: [] }; // file_paths merged below
      }
    } else {
      groups.set(key, {
        filePaths: new Set(finding.file_paths),
        primary: finding,
        rootCauseKey: key,
      });
    }
  }

  const deduped: SecurityFinding[] = [];

  for (const group of groups.values()) {
    // Deterministic file path ordering
    const sortedPaths = [...group.filePaths].sort();

    // Recompute stable vuln_id for the merged finding
    const stableVulnId = computeVulnId({
      cwe: group.primary.cwe,
      filePaths: sortedPaths,
      title: group.primary.title,
    });

    deduped.push({
      ...group.primary,
      file_paths: sortedPaths,
      vuln_id: stableVulnId,
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
