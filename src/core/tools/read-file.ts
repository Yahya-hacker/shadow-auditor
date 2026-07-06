import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { type PathGuard, PathGuardError } from '../policy/path-guard.js';

export function createReadFileTool(pathGuard: PathGuard) {
  return {
    description:
      'Reads source code from a repository file using hardened path guards. ' +
      'Use this for implementation-level security analysis AFTER identifying relevant files via search.\n\n' +
      'LINE RANGES: ALWAYS use startLine/endLine to read only the section you need. ' +
      'Reading an entire 2000-line file wastes tokens — request only the 30-80 lines ' +
      'surrounding the vulnerability candidate. If you omit startLine/endLine, only ' +
      'the first 100 lines are returned with a summary of the rest.\n\n' +
      'USAGE: { filePath: "src/auth/login.ts", startLine: 40, endLine: 90 }\n' +
      'BEFORE: Always use context_retrieval or search_codebase first to identify which files AND which line ranges to read.\n' +
      'AVOID: Don\'t read entire large files. Don\'t read files you haven\'t first identified as relevant through search.',
    async execute({
      filePath,
      startLine,
      endLine,
    }: {
      filePath: string;
      startLine?: number;
      endLine?: number;
    }) {
      try {
        const absolutePath = await pathGuard.resolveExistingPath(filePath);
        const content = await fs.readFile(absolutePath, 'utf8');
        const relativePath = pathGuard.toRelative(absolutePath);
        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;

        // ── Line-range read (preferred path) ──────────────────────
        if (startLine !== undefined || endLine !== undefined) {
          const start = Math.max(1, startLine ?? 1);
          const end = Math.min(totalLines, endLine ?? start + 50);
          const clampedEnd = Math.min(end, start + 200); // Cap at 200 lines

          const selected = lines.slice(start - 1, clampedEnd);
          const omittedBefore = start - 1;
          const omittedAfter = totalLines - clampedEnd;

          const parts: string[] = [
            `── FILE: ${relativePath} (lines ${start}-${clampedEnd} of ${totalLines}) ──`,
          ];
          if (omittedBefore > 0) {
            parts.push(`... ${omittedBefore} lines above omitted (use startLine to see them) ...`);
          }
          parts.push(selected.join('\n'));
          if (omittedAfter > 0) {
            parts.push(`... ${omittedAfter} lines below omitted (use endLine to see them) ...`);
          }

          return parts.join('\n');
        }

        // ── Full-file read (auto-truncated) ──────────────────────
        if (totalLines <= 100) {
          return `── FILE: ${relativePath} (${totalLines} lines) ──\n${content}`;
        }

        // Show first 100 lines + summary of rest
        const preview = lines.slice(0, 100).join('\n');
        const remaining = totalLines - 100;
        return [
          `── FILE: ${relativePath} (${totalLines} lines total, showing first 100) ──`,
          preview,
          '',
          `── ${remaining} more lines not shown ──`,
          `💡 This file has ${totalLines} lines. Use startLine/endLine to read specific sections.`,
          `   Example: read_file_content({ filePath: "${relativePath}", startLine: 100, endLine: 180 })`,
          ``,
          `Quick overview of remaining content:`,
          ...buildQuickOverview(lines.slice(100)),
        ].join('\n');
      } catch (error) {
        if (error instanceof PathGuardError) {
          return `[ERROR] ${error.message}`;
        }

        return `[ERROR] Could not read file "${filePath}": ${(error as Error).message}`;
      }
    },
    inputSchema: z.object({
      filePath: z.string().describe('Relative file path from the repository root.'),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line number to read (1-based). Always specify this for large files.'),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Last line number to read (1-based). Defaults to startLine+50 if startLine is set.'),
    }),
  };
}

/**
 * Build a quick structural overview of the remaining lines — function
 * signatures, imports, class declarations — so the agent can decide
 * which line ranges to request next without reading everything.
 */
function buildQuickOverview(lines: string[]): string[] {
  const signatures: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    // Capture function/class/import declarations
    if (
      /^(export\s+)?(async\s+)?function\s+\w/.test(line) ||
      /^(export\s+)?(class|interface|enum)\s+\w/.test(line) ||
      /^(export\s+)?(const|let|var)\s+\w+\s*=/.test(line) ||
      /^import\s/.test(line) ||
      /^export\s/.test(line)
    ) {
      const actualLineNum = i + 101; // offset from line 101
      const snippet = line.slice(0, 100);
      signatures.push(`  L${actualLineNum}: ${snippet}${snippet.length >= 100 ? '...' : ''}`);
      if (signatures.length >= 20) {
        signatures.push(`  ... and more (showing first 20 declarations)`);
        break;
      }
    }
  }

  return signatures.length > 0
    ? ['Key declarations in remaining lines:', ...signatures]
    : ['(No function/class/import declarations detected in remaining lines)'];
}
