/**
 * Patch Logical Verifier — Statically analyzes a synthesized patch for
 * correctness, idiom preservation, and multi-language interface integrity.
 *
 * Performs a series of deterministic checks on the unified diff:
 * 1. Syntax validity: does the diff apply cleanly? (no malformed hunks)
 * 2. Import completeness: are all referenced symbols imported?
 * 3. Type consistency: do types match across the merged changes?
 * 4. Control flow integrity: does the control flow remain valid?
 * 5. Idiom preservation: does the code respect language conventions?
 * 6. Interface bridge: are multi-language API boundaries intact?
 * 7. Test compatibility: would existing tests schema remain valid?
 */

import * as crypto from 'node:crypto';

import {
  type VerificationCheck,
  type VerificationReport,
} from './patch-competition-schema.js';
import { parseUnifiedDiff } from './patch-conflict-detector.js';

interface VerificationOptions {
  /** Known interface bridges (cross-language API boundaries) */
  interfaceBridges?: Array<{ exports: string[]; file: string; }>;
  /** Known language idioms to check against */
  languageIdioms?: Record<string, string[]>;
  /** Whether to run strict type checking */
  strictMode?: boolean;
}

/**
 * Verify the logical correctness of a synthesized patch diff.
 *
 * Returns a VerificationReport with all checks, their statuses,
 * and an overall verdict.
 */
export function verifySynthesizedPatch(
  unifiedDiff: string,
  options: VerificationOptions = {},
): VerificationReport {
  const checks: VerificationCheck[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!unifiedDiff.trim()) {
    return {
      checks: [{
        checkId: `check_${crypto.randomBytes(4).toString('hex')}`,
        checkType: 'syntax_validity',
        description: 'Empty diff cannot be verified or applied.',
        status: 'fail',
      }],
      errors: ['Diff is empty.'],
      overallVerdict: 'rejected',
      timestamp: new Date().toISOString(),
      warnings: [],
    };
  }

  // Parse the diff
  let parsed;
  try {
    parsed = parseUnifiedDiff(unifiedDiff);
  } catch {
    return {
      checks: [{
        checkId: `check_${crypto.randomBytes(4).toString('hex')}`,
        checkType: 'syntax_validity',
        description: 'Failed to parse the unified diff — malformed format.',
        status: 'fail',
      }],
      errors: ['Diff parsing failed: invalid unified diff format.'],
      overallVerdict: 'rejected',
      timestamp: new Date().toISOString(),
      warnings: [],
    };
  }

  if (parsed.length === 0) {
    return {
      checks: [{
        checkId: `check_${crypto.randomBytes(4).toString('hex')}`,
        checkType: 'syntax_validity',
        description: 'Input contains no unified-diff file headers or hunks.',
        status: 'fail',
      }],
      errors: ['No applicable file changes were found in the supplied text.'],
      overallVerdict: 'rejected',
      timestamp: new Date().toISOString(),
      warnings: [],
    };
  }

  // ── Check 1: Syntax Validity ──────────────────────────────────────
  // ── Check 2: Import Completeness ──────────────────────────────────
  checks.push(...verifySyntaxValidity(parsed, unifiedDiff), ...verifyImportCompleteness(parsed));

  // ── Check 3: Type Consistency ─────────────────────────────────────
  if (options.strictMode) {
    checks.push(...verifyTypeConsistency(parsed));
  }

  // ── Check 4: Control Flow Integrity ───────────────────────────────
  checks.push(...verifyControlFlowIntegrity(parsed));

  // ── Check 5: Idiom Preservation ───────────────────────────────────
  if (options.languageIdioms) {
    checks.push(...verifyIdiomPreservation(parsed, options.languageIdioms));
  }

  // ── Check 6: Interface Bridge ─────────────────────────────────────
  if (options.interfaceBridges?.length) {
    checks.push(...verifyInterfaceBridges(parsed, options.interfaceBridges));
  }

  // ── Check 7: Test Compatibility ──────────────────────────────────
  checks.push(...verifyTestCompatibility(parsed));

  // Aggregate
  for (const check of checks) {
    if (check.status === 'fail') {
      errors.push(`[${check.checkType}] ${check.description}`);
    } else if (check.status === 'warning') {
      warnings.push(`[${check.checkType}] ${check.description}`);
    }
  }

  const hasFailures = checks.some((c) => c.status === 'fail');
  const hasWarnings = checks.some((c) => c.status === 'warning');

  return {
    checks,
    errors,
    overallVerdict: hasFailures ? 'rejected' : hasWarnings ? 'warning' : 'approved',
    timestamp: new Date().toISOString(),
    warnings,
  };
}

// ==========================================================================
// Individual verification checks
// ==========================================================================

function makeCheck(
  type: VerificationCheck['checkType'],
  status: VerificationCheck['status'],
  description: string,
  filePath?: string,
  suggestion?: string,
): VerificationCheck {
  return {
    checkId: `check_${crypto.randomBytes(4).toString('hex')}`,
    checkType: type,
    description,
    filePath,
    status,
    suggestion,
  };
}

function verifySyntaxValidity(
  parsed: ReturnType<typeof parseUnifiedDiff>,
  _originalDiff: string,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  for (const file of parsed) {
    if (file.hunks.length === 0) {
      checks.push(makeCheck(
        'syntax_validity', 'fail',
        `File ${file.filePath} has no hunks — no changes applied.`,
        file.filePath,
      ));
      continue;
    }

    for (const hunk of file.hunks) {
      // Check that oldCount/newCount match the actual line counts
      const actualAdded = hunk.lines.filter((l) => l.kind === 'added').length;
      const actualRemoved = hunk.lines.filter((l) => l.kind === 'removed').length;
      const actualContext = hunk.lines.filter((l) => l.kind === 'context').length;

      const expectedOldCount = actualRemoved + actualContext;
      const expectedNewCount = actualAdded + actualContext;

      if (hunk.oldCount !== expectedOldCount) {
        checks.push(makeCheck(
          'syntax_validity', 'warning',
          `Hunk in ${file.filePath} has oldCount=${hunk.oldCount} but actual lines=${expectedOldCount}. Diff may not apply cleanly.`,
          file.filePath,
          'Review the unified diff header counts.',
        ));
      }

      if (hunk.newCount !== expectedNewCount) {
        checks.push(makeCheck(
          'syntax_validity', 'warning',
          `Hunk in ${file.filePath} has newCount=${hunk.newCount} but actual lines=${expectedNewCount}.`,
          file.filePath,
          'Review the unified diff header counts.',
        ));
      }

      // Check for conflict markers that weren't resolved
      const hasConflictMarkers = hunk.lines.some(
        (l) => l.content.includes('<<<<<<<') || l.content.includes('=======') || l.content.includes('>>>>>>>'),
      );
      if (hasConflictMarkers) {
        checks.push(makeCheck(
          'syntax_validity', 'warning',
          `File ${file.filePath} contains unresolved conflict markers (<<<<<<, =======, >>>>>>>). Manual resolution required.`,
          file.filePath,
          'Resolve all marked conflicts before applying the patch.',
        ));
      }
    }
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      'syntax_validity', 'pass',
      'All hunks have valid structure and line counts.',
    ));
  }

  return checks;
}

function verifyImportCompleteness(
  parsed: ReturnType<typeof parseUnifiedDiff>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  for (const file of parsed) {
    const ext = file.filePath.split('.').pop()?.toLowerCase();
    if (!ext || !['go', 'js', 'jsx', 'py', 'rs', 'ts', 'tsx'].includes(ext)) continue;

    const allLines = file.hunks.flatMap((h) => h.lines);

    // Find added lines that reference symbols
    const addedLines = allLines.filter((l) => l.kind === 'added');
    const imports = allLines.filter(
      (l) => l.kind === 'context' || l.kind === 'added',
    ).filter((l) =>
      l.content.includes('import ') || l.content.includes('from ') ||
      l.content.includes('require(') || l.content.includes('use '),
    );

    // Simple heuristic: if we're adding code that uses external APIs,
    // check that the imports exist somewhere in the file's diff
    for (const line of addedLines) {
      // Check for common API usage patterns
      const apiPatterns = [
        /\.execute\(/, /\.query\(/, /\.fetch\(/, /\.write\(/,
        /\.readFile\(/, /\.appendFile\(/, /JSON\.parse/, /JSON\.stringify/,
        /crypto\./, /Buffer\./, /process\./,
      ];

      for (const pattern of apiPatterns) {
        if (pattern.test(line.content)) {
          // API usage detected — verify a corresponding import exists
          // in the file's diff context (added or context lines).
          const apiName = line.content.match(pattern)?.[0] ?? '';
          const hasImport = imports.some((imp) =>
            imp.content.includes(apiName.replace(/[.(]$/, '')),
          );
          if (!hasImport) {
            checks.push(makeCheck(
              'import_completeness', 'warning',
              `File ${file.filePath}: API usage "${apiName}" detected but no corresponding import found in diff.`,
              file.filePath,
              `Verify that "${apiName}" is imported or available in scope.`,
            ));
          }

          break;
        }
      }
    }
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      'import_completeness', 'pass',
      'No obvious missing imports detected in the diff.',
    ));
  }

  return checks;
}

function verifyTypeConsistency(
  parsed: ReturnType<typeof parseUnifiedDiff>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  for (const file of parsed) {
    const ext = file.filePath.split('.').pop()?.toLowerCase();
    if (!ext || !['ts', 'tsx'].includes(ext)) continue;

    const addedLines = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'added');
    const removedLines = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'removed');

    // Check for removed type annotations without replacement
    const removedTypeAnnotations = removedLines.filter(
      (l) => /:\s*(string|number|boolean|void|any|never|unknown|Promise|Array|Record|Map|Set)\b/.test(l.content),
    );
    const addedTypeAnnotations = addedLines.filter(
      (l) => /:\s*(string|number|boolean|void|any|never|unknown|Promise|Array|Record|Map|Set)\b/.test(l.content),
    );

    if (removedTypeAnnotations.length > 0 && addedTypeAnnotations.length === 0) {
      checks.push(makeCheck(
        'type_consistency', 'warning',
        `File ${file.filePath} removes type annotations without adding replacements. This may weaken type safety.`,
        file.filePath,
        'Ensure all removed types are replaced with equivalent or stricter types.',
      ));
    }
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      'type_consistency', 'pass',
      'No type consistency issues detected in the diff.',
    ));
  }

  return checks;
}

function verifyControlFlowIntegrity(
  parsed: ReturnType<typeof parseUnifiedDiff>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const warnings: string[] = [];

  for (const file of parsed) {
    const allLines = file.hunks.flatMap((h) => h.lines);
    const addedLines = allLines.filter((l) => l.kind === 'added').map((l) => l.content);
    const removedLines = allLines.filter((l) => l.kind === 'removed').map((l) => l.content);

    // Check for orphaned control structures (unbalanced braces)
    const addedBraces = addedLines.filter((l) => l.includes('{')).length;
    const addedCloseBraces = addedLines.filter((l) => l.includes('}')).length;
    const removedBraces = removedLines.filter((l) => l.includes('{')).length;
    const removedCloseBraces = removedLines.filter((l) => l.includes('}')).length;

    const braceBalance = (addedBraces - addedCloseBraces) - (removedBraces - removedCloseBraces);
    if (Math.abs(braceBalance) > 2) {
      warnings.push(`${file.filePath}: unbalanced braces detected (added: ${addedBraces}/${addedCloseBraces}, removed: ${removedBraces}/${removedCloseBraces})`);
    }

    // Check for return/throw/break after removal
    const removedReturns = removedLines.filter((l) => /^\s*return\b/.test(l)).length;
    const addedReturns = addedLines.filter((l) => /^\s*return\b/.test(l)).length;
    if (removedReturns > addedReturns + 1) {
      warnings.push(`${file.filePath}: removed ${removedReturns} return statements but only added ${addedReturns}. Functions may now fall through unexpectedly.`);
    }
  }

  for (const w of warnings) {
    checks.push(makeCheck('control_flow_integrity', 'warning', w));
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      'control_flow_integrity', 'pass',
      'No control flow integrity issues detected.',
    ));
  }

  return checks;
}

function verifyIdiomPreservation(
  parsed: ReturnType<typeof parseUnifiedDiff>,
  idioms: Record<string, string[]>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  for (const file of parsed) {
    const ext = file.filePath.split('.').pop()?.toLowerCase() ?? '';
    const langIdioms = idioms[ext] ?? [];

    if (langIdioms.length === 0) continue;

    const addedLines = file.hunks.flatMap((h) => h.lines)
      .filter((l) => l.kind === 'added')
      .map((l) => l.content);

    // Check if added code uses non-idiomatic patterns
    for (const idiom of langIdioms) {
      // Idioms are regex patterns that SHOULD be present in well-written code.
      // Test each idiom against the added lines; warn when no match is found.
      const idiomRegex = new RegExp(idiom, 'i');
      const matchesIdiom = addedLines.some((line) => idiomRegex.test(line));

      if (addedLines.length > 0 && !matchesIdiom) {
        checks.push(makeCheck(
          'idiom_preservation', 'warning',
          `File ${file.filePath}: added code does not match idiom pattern "${idiom}". Code may not follow language conventions.`,
          file.filePath,
          'Review added code to ensure it follows idiomatic patterns for the language.',
        ));
      }
    }
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      'idiom_preservation', 'pass',
      'No language idiom violations detected (heuristic check).',
    ));
  }

  return checks;
}

function verifyInterfaceBridges(
  parsed: ReturnType<typeof parseUnifiedDiff>,
  bridges: Array<{ exports: string[]; file: string; }>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  for (const bridge of bridges) {
    const fileDiff = parsed.find((f) => f.filePath === bridge.file);
    if (!fileDiff) continue;

    const removedLines = fileDiff.hunks.flatMap((h) => h.lines)
      .filter((l) => l.kind === 'removed')
      .map((l) => l.content);

    // Check if any bridge exports were removed
    for (const exp of bridge.exports) {
      const wasRemoved = removedLines.some((l) => l.includes(exp));
      if (wasRemoved) {
        checks.push(makeCheck(
          'interface_bridge', 'fail',
          `Cross-language interface bridge "${exp}" was removed from ${bridge.file}. This may break multi-language communication.`,
          bridge.file,
          `Ensure the export "${exp}" is preserved or replaced with an equivalent interface.`,
        ));
      }
    }
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      'interface_bridge', 'pass',
      'All known interface bridges are intact.',
    ));
  }

  return checks;
}

function verifyTestCompatibility(
  parsed: ReturnType<typeof parseUnifiedDiff>,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const testFiles = parsed.filter(
    (f) => f.filePath.includes('.test.') || f.filePath.includes('.spec.') ||
      f.filePath.includes('__tests__') || f.filePath.includes('/test/'),
  );

  for (const testFile of testFiles) {
    const removedLines = testFile.hunks.flatMap((h) => h.lines)
      .filter((l) => l.kind === 'removed')
      .map((l) => l.content);

    // Check for removed test cases
    const removedTests = removedLines.filter(
      (l) => /^\s*(it|test|describe)\s*\(/.test(l) || /^\s*def test_/.test(l),
    );

    if (removedTests.length > 0) {
      checks.push(makeCheck(
        'test_compatibility', 'warning',
        `${testFile.filePath}: ${removedTests.length} test case(s) removed. Verify that the removed tests are truly obsolete.`,
        testFile.filePath,
        'Consider updating tests instead of removing them if the behavior changed.',
      ));
    }
  }

  if (checks.length === 0 && testFiles.length > 0) {
    checks.push(makeCheck(
      'test_compatibility', 'pass',
      `Test files modified (${testFiles.length}) but no test cases were removed.`,
    ));
  } else if (testFiles.length === 0) {
    checks.push(makeCheck(
      'test_compatibility', 'pass',
      'No test files modified in this patch.',
    ));
  }

  return checks;
}
