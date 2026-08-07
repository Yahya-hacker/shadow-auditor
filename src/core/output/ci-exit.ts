/**
 * CI Exit Code Helper
 *
 * Determines the process exit code for CI-grade runs based on the severity
 * of findings and a configurable failure threshold.
 *
 * Exit codes:
 *  0  — success (no findings at or above the threshold)
 *  1  — findings found at or above the threshold
 *  2  — internal error / invalid configuration
 */

import type { SecurityFinding } from './report-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailOnSeverity = 'critical' | 'high' | 'low' | 'medium' | 'none';

export interface CiExitOptions {
  /** Severity level at which to exit non-zero. Default: "high". */
  failOn?: FailOnSeverity;
  /** Array of findings from the completed audit. */
  findings: SecurityFinding[];
}

export interface CiExitResult {
  /** Exit code to pass to process.exit() */
  code: number;
  /** Human-readable explanation */
  message: string;
  /** Findings that triggered the non-zero exit (may be empty) */
  triggeringFindings: SecurityFinding[];
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<SecurityFinding['severity_label'], number> = {
  Critical: 5,
  High: 4,
  Info: 1,
  Low: 2,
  Medium: 3,
};

const FAIL_ON_TO_LABEL: Record<FailOnSeverity, null | SecurityFinding['severity_label']> = {
  critical: 'Critical',
  high: 'High',
  low: 'Low',
  medium: 'Medium',
  none: null,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the CI exit code and result summary for a completed audit.
 */
export function computeCiExitCode(options: CiExitOptions): CiExitResult {
  const failOn = options.failOn ?? 'high';
  const threshold = FAIL_ON_TO_LABEL[failOn];

  // "none" → always exit 0
  if (threshold === null) {
    return {
      code: 0,
      message: '--fail-on none: exit code always 0',
      triggeringFindings: [],
    };
  }

  const thresholdOrder = SEVERITY_ORDER[threshold];

  const triggeringFindings = options.findings.filter((f) => {
    const order = SEVERITY_ORDER[f.severity_label];
    return order !== undefined && order >= thresholdOrder;
  });

  if (triggeringFindings.length === 0) {
    return {
      code: 0,
      message: `No findings at or above severity "${failOn}"`,
      triggeringFindings: [],
    };
  }

  const severityCounts: Record<string, number> = {};
  for (const f of triggeringFindings) {
    severityCounts[f.severity_label] = (severityCounts[f.severity_label] ?? 0) + 1;
  }

  const countSummary = Object.entries(severityCounts)
    .sort((a, b) => (SEVERITY_ORDER[b[0] as SecurityFinding['severity_label']] ?? 0) - (SEVERITY_ORDER[a[0] as SecurityFinding['severity_label']] ?? 0))
    .map(([sev, count]) => `${count} ${sev}`)
    .join(', ');

  return {
    code: 1,
    message: `Found ${triggeringFindings.length} finding(s) at or above "${failOn}" threshold: ${countSummary}`,
    triggeringFindings,
  };
}

/**
 * Format a human-readable CI summary for console output.
 */
export function formatCiSummary(result: CiExitResult, failOn: FailOnSeverity = 'high'): string {
  const status = result.code === 0 ? '✅ PASS' : '❌ FAIL';
  const parts = [
    `${status} Shadow Auditor CI (--fail-on ${failOn})`,
    result.message,
  ];

  if (result.triggeringFindings.length > 0) {
    parts.push('', 'Triggering findings:');
    for (const f of result.triggeringFindings) {
      parts.push(`  [${f.severity_label}] ${f.vuln_id} — ${f.title}`);
    }
  }

  return parts.join('\n');
}
