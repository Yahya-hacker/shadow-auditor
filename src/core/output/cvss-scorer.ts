/**
 * CVSS v3.1 Scorer Helper
 *
 * Validates CVSS v3.1 vector strings and computes base scores from them.
 * Provides consistency checks to warn or auto-correct mismatched score/vector
 * pairs.
 */

// ---------------------------------------------------------------------------
// CVSS v3.1 metric value maps
// ---------------------------------------------------------------------------

type MetricKey =
  | 'A'   // Availability Impact
  | 'AC'  // Attack Complexity
  | 'AV'  // Attack Vector
  | 'C'   // Confidentiality Impact
  | 'I'   // Integrity Impact
  | 'PR'  // Privileges Required
  | 'S'   // Scope
  | 'UI'; // User Interaction

const METRIC_VALUES: Record<MetricKey, Record<string, number>> = {
  A:  { H: 0.56, L: 0.22, N: 0 },
  AC: { H: 0.44, L: 0.77 },
  AV: { A: 0.62, L: 0.55, N: 0.85, P: 0.2 },
  C:  { H: 0.56, L: 0.22, N: 0 },
  I:  { H: 0.56, L: 0.22, N: 0 },
  PR: { H: 0.27, L: 0.68, N: 0.85 },
  S:  { C: 1, U: 0 },   // Scope: Changed=1, Unchanged=0 (used as flag)
  UI: { N: 0.85, R: 0.62 },
};

// Scope-adjusted PR values (used when S=C)
const PR_SCOPE_CHANGED: Record<string, number> = { H: 0.5, L: 0.68, N: 0.85 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CvssParseResult {
  error?: string;
  metrics?: Partial<Record<MetricKey, string>>;
  valid: boolean;
  vector: string;
}

export interface CvssScoreResult {
  /** Computed base score (0.0–10.0, 1 decimal) */
  baseScore: number;
  /** Qualitative severity label */
  severityLabel: 'Critical' | 'High' | 'Info' | 'Low' | 'Medium';
}

export interface CvssConsistencyResult {
  /** Auto-corrected score (if inconsistency found) */
  correctedScore?: number;
  isConsistent: boolean;
  /** Human-readable explanation */
  message: string;
  /** Delta between reported and computed score */
  scoreDelta?: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CVSS v3.1 vector string into its component metrics.
 *
 * Returns `{ valid: false, error }` if the vector is malformed.
 */
export function parseCvssVector(vector: string): CvssParseResult {
  if (!vector.startsWith('CVSS:3.1/')) {
    return { error: 'Vector must start with "CVSS:3.1/"', valid: false, vector };
  }

  const body = vector.slice('CVSS:3.1/'.length);
  const parts = body.split('/');

  const metrics: Partial<Record<MetricKey, string>> = {};
  const required: MetricKey[] = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];

  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) {
      return { error: `Malformed metric component: "${part}"`, valid: false, vector };
    }

    const key = part.slice(0, colonIdx) as MetricKey;
    const val = part.slice(colonIdx + 1);

    if (!METRIC_VALUES[key]) {
      // Unknown metric — skip (temporal/environmental)
      continue;
    }

    if (METRIC_VALUES[key][val] === undefined) {
      return {
        error: `Unknown value "${val}" for metric "${key}"`,
        valid: false,
        vector,
      };
    }

    metrics[key] = val;
  }

  // Check all required base metrics are present
  for (const req of required) {
    if (!metrics[req]) {
      return { error: `Missing required metric "${req}"`, valid: false, vector };
    }
  }

  return { metrics, valid: true, vector };
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute the CVSS v3.1 base score from parsed metrics.
 *
 * Implements the formula from CVSS v3.1 specification:
 * https://www.first.org/cvss/specification-document
 */
export function computeCvssBaseScore(metrics: Partial<Record<MetricKey, string>>): number {
  const AV  = METRIC_VALUES.AV[metrics.AV ?? ''] ?? 0;
  const AC  = METRIC_VALUES.AC[metrics.AC ?? ''] ?? 0;
  const UI  = METRIC_VALUES.UI[metrics.UI ?? ''] ?? 0;
  const S   = metrics.S === 'C'; // true = Changed
  const C   = METRIC_VALUES.C[metrics.C ?? ''] ?? 0;
  const I   = METRIC_VALUES.I[metrics.I ?? ''] ?? 0;
  const A   = METRIC_VALUES.A[metrics.A ?? ''] ?? 0;
  const PRv = metrics.PR ?? 'N';
  const PR  = S ? (PR_SCOPE_CHANGED[PRv] ?? 0) : (METRIC_VALUES.PR[PRv] ?? 0);

  // Exploitability
  const exploitability = 8.22 * AV * AC * PR * UI;

  // Impact sub-score
  const ISCBase = 1 - (1 - C) * (1 - I) * (1 - A);
  const ISS = S
    ? 7.52 * (ISCBase - 0.029) - 3.25 * (ISCBase - 0.02) ** 15
    : 6.42 * ISCBase;

  if (ISS <= 0) {
    return 0;
  }

  const rawScore = S
    ? Math.min(1.08 * (ISS + exploitability), 10)
    : Math.min(ISS + exploitability, 10);

  // Round up to 1 decimal place (CVSS spec: roundup)
  return Math.ceil(rawScore * 10) / 10;
}

// ---------------------------------------------------------------------------
// Severity label
// ---------------------------------------------------------------------------

/**
 * Convert a CVSS v3.1 base score to a qualitative severity label.
 */
export function cvssScoreToSeverityLabel(score: number): 'Critical' | 'High' | 'Info' | 'Low' | 'Medium' {
  if (score >= 9) return 'Critical';
  if (score >= 7) return 'High';
  if (score >= 4) return 'Medium';
  if (score >= 0.1) return 'Low';
  return 'Info';
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Validate a CVSS v3.1 vector and compute its base score.
 *
 * Returns `null` if the vector is invalid.
 */
export function scoreCvssVector(vector: string): CvssScoreResult | null {
  const parsed = parseCvssVector(vector);
  if (!parsed.valid || !parsed.metrics) {
    return null;
  }

  const baseScore = computeCvssBaseScore(parsed.metrics);
  return {
    baseScore,
    severityLabel: cvssScoreToSeverityLabel(baseScore),
  };
}

/**
 * Check whether a reported CVSS score is consistent with the vector.
 *
 * Tolerance of ±0.5 is allowed to account for rounding differences between
 * implementations. Outside that range, an auto-corrected score is returned.
 */
export function checkCvssConsistency(
  reportedScore: number,
  vector: string,
  tolerance = 0.5,
): CvssConsistencyResult {
  const parsed = parseCvssVector(vector);
  if (!parsed.valid || !parsed.metrics) {
    return {
      isConsistent: false,
      message: `Invalid CVSS vector: ${parsed.error ?? 'unknown error'}`,
    };
  }

  const computed = computeCvssBaseScore(parsed.metrics);
  const delta = Math.abs(reportedScore - computed);

  if (delta <= tolerance) {
    return {
      isConsistent: true,
      message: `Score ${reportedScore.toFixed(1)} is consistent with vector (computed: ${computed.toFixed(1)})`,
    };
  }

  return {
    correctedScore: computed,
    isConsistent: false,
    message: `Score mismatch: reported ${reportedScore.toFixed(1)} vs computed ${computed.toFixed(1)} (delta ${delta.toFixed(1)})`,
    scoreDelta: delta,
  };
}
