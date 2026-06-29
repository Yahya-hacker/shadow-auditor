/**
 * Deterministic Vulnerability Fingerprinting
 *
 * Generates stable `vuln_id` values that are reproducible across reruns
 * for the same finding in the same codebase.
 *
 * ID is derived from:
 *  - Normalized title / type
 *  - Primary file path + symbol name (when available)
 *  - CWE identifier
 *  - Key evidence locations (line numbers, normalized)
 */

import * as crypto from 'node:crypto';

export interface FingerprintInput {
  /** CWE identifier, e.g. "CWE-89" */
  cwe: string;
  /** Primary file paths (first is used as primary) */
  filePaths?: string[];
  /** Optional line numbers from primary evidence locations */
  lineNumbers?: number[];
  /** Optional symbol name (function, class, variable) */
  symbolName?: string;
  /** Vulnerability title */
  title: string;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a vulnerability title for stable hashing.
 * Lowercases, strips punctuation/whitespace.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^\w\s]/g, '')
    .replaceAll(/\s+/g, '_')
    .trim();
}

/**
 * Normalize a file path to POSIX format and strip leading "./" .
 */
function normalizeFilePath(filePath: string): string {
  let normalized = filePath.replaceAll('\\', '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  return normalized.replaceAll(/\/+/g, '/');
}

/**
 * Normalize line numbers by sorting and deduplicating.
 */
function normalizeLineNumbers(lines: number[]): number[] {
  return [...new Set(lines)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic, stable vulnerability ID from the given inputs.
 *
 * The resulting ID has the form:
 *   `SHADOW-<CWE_SHORT>-<HEX8>`
 *
 * where HEX8 is the first 8 hex characters of a SHA-256 digest of the
 * normalised inputs, and CWE_SHORT is derived from the CWE (e.g. "089" for
 * CWE-89).
 *
 * Same inputs → same ID; changing CWE/file/title/lines → different ID.
 */
export function computeVulnId(input: FingerprintInput): string {
  const normalizedTitle = normalizeTitle(input.title);
  const normalizedCwe = input.cwe.toUpperCase().trim();
  const primaryFile = input.filePaths?.[0] ? normalizeFilePath(input.filePaths[0]) : 'unknown';
  const symbol = input.symbolName ? input.symbolName.trim() : '';
  const lines = input.lineNumbers ? normalizeLineNumbers(input.lineNumbers) : [];

  const hashInput = [
    `cwe:${normalizedCwe}`,
    `title:${normalizedTitle}`,
    `file:${primaryFile}`,
    `symbol:${symbol}`,
    `lines:${lines.join(',')}`,
  ].join('|');

  const hex8 = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8).toUpperCase();

  // Extract numeric part from CWE for the ID segment (zero-pad to 3 digits)
  const cweNumMatch = /(\d+)/.exec(normalizedCwe);
  const cweShort = cweNumMatch ? cweNumMatch[1].padStart(3, '0') : '000';

  return `SHADOW-${cweShort}-${hex8}`;
}

/**
 * Generate a root-cause fingerprint string used to group duplicate findings.
 *
 * This is intentionally broader than computeVulnId — it ignores specific
 * line numbers and symbol names so that multiple occurrences of the same
 * vulnerability class in the same file cluster under one root cause.
 */
export function computeRootCauseFingerprint(input: FingerprintInput): string {
  const normalizedTitle = normalizeTitle(input.title);
  const normalizedCwe = input.cwe.toUpperCase().trim();
  const primaryFile = input.filePaths?.[0] ? normalizeFilePath(input.filePaths[0]) : 'unknown';

  const hashInput = [
    `cwe:${normalizedCwe}`,
    `title:${normalizedTitle}`,
    `file:${primaryFile}`,
  ].join('|');

  return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}
