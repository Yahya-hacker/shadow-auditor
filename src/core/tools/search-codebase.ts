import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

import type { PathGuard } from '../policy/path-guard.js';

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.svelte',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.yaml',
  '.yml',
]);

const SKIP_DIRS = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);

function normalizeExtensionFilter(extension?: string): string | undefined {
  if (!extension) {
    return undefined;
  }

  const normalized = extension.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

/**
 * Detect potentially dangerous regex patterns that could cause ReDoS
 * (Regular expression Denial of Service).
 *
 * Static detection of every catastrophic pattern is undecidable in general,
 * so this intentionally errs toward rejecting ambiguous structural shapes
 * that are known to exhibit exponential or high-degree polynomial
 * backtracking:
 *
 *   - nested quantifiers: `(a+)+`, `(a*)*`, `(a+)*`, `(a*)+`, or `a+*`/`a*+`
 *   - a quantified group containing an alternation: `(a|b)+`, `(a|aa)*` —
 *     when two branches can consume the same characters the engine must try
 *     every split, which is the classic ReDoS shape
 *
 * These rejections are cheap, deterministic, and cover the constructs that
 * actually hung scans (>30s on `(a|aa)+$`). A truly safe fallback for exotic
 * patterns is unavailable here because a synchronous `RegExp.test` cannot be
 * aborted; operators are expected to use anchored literal searches instead.
 */
const REDOS_NESTED_QUANTIFIER =
  /\([^)]*?(?:\+|\*)\s*\)\s*(?:\+|\*)/;

const REDOS_QUANTIFIED_ALTERNATION =
  /\([^()]*\|[^()]*\)\s*(?:\+\??|\*\??|\{\d+,\})/;

// Strip escaped characters and character classes so alternation detection does
// not trip on legitimate uses inside classes (e.g. [a|b]).
function stripCluster(pattern: string): string {
  return pattern.replaceAll(/\\[\s\S]/g, 'x').replaceAll(/\[[^\]]*\]/g, 'x');
}

function isReDosRisk(pattern: string): boolean {
  if (pattern.length > 200) {
    return true;
  }

  const body = stripCluster(pattern);
  return REDOS_NESTED_QUANTIFIER.test(body) || REDOS_QUANTIFIED_ALTERNATION.test(body);
}

interface FileMatch {
  filePath: string;
  lines: Array<{ content: string; lineNumber: number; }>;
}

export function createSearchCodebaseTool(pathGuard: PathGuard) {
  return {
    description:
      'Searches code for regex patterns with text-file filtering and symlink-safe traversal. ' +
      'Excludes node_modules and .git. Best for finding exact code patterns across the entire codebase.\n\n' +
      'USAGE EXAMPLES:\n' +
      '- { regexPattern: "eval\\\\s*\\\\(", fileExtension: ".js" } — find eval() calls in JS files\n' +
      '- { regexPattern: "dangerouslySetInnerHTML" } — find React XSS risks\n' +
      '- { regexPattern: "exec\\\\s*\\\\(\\\\s*[\'\\"](?:sh|bash|cmd)" } — find shell command execution\n' +
      '- { regexPattern: "SELECT.*\\\\+.*FROM", fileExtension: ".java" } — find SQL string concatenation\n' +
      'CHAIN: After search_codebase finds matches, use read_file_content with startLine/endLine on the matched files.\n' +
      'AVOID: Don\'t use for semantic queries ("authentication logic"). Use context_retrieval for that instead.\n' +
      'TIP: Narrow results with fileExtension filter. Start broad, then narrow.',
    async execute({ fileExtension, regexPattern }: { fileExtension?: string; regexPattern: string }) {
      const extensionFilter = normalizeExtensionFilter(fileExtension);
      let regex: RegExp;

      try {
        if (isReDosRisk(regexPattern)) {
          return `[ERROR] Regex pattern rejected: contains nested quantifiers which can cause catastrophic backtracking (ReDoS). Simplify your pattern.`;
        }

        regex = new RegExp(regexPattern, 'gi');
      } catch (error) {
        return `[ERROR] Invalid regex pattern: ${(error as Error).message}`;
      }

      // Collect matches grouped by file
      const fileMatches: FileMatch[] = [];
      let totalMatches = 0;

      async function walk(directoryPath: string): Promise<void> {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) {
            continue;
          }

          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
            continue;
          }

          const fullPath = path.join(directoryPath, entry.name);
          const lstat = await fs.lstat(fullPath);
          if (lstat.isSymbolicLink()) {
            continue;
          }

          if (entry.isDirectory()) {
            await walk(fullPath);
            continue;
          }

          if (!entry.isFile()) {
            continue;
          }

          const ext = path.extname(entry.name);
          if (extensionFilter && ext !== extensionFilter) {
            continue;
          }

          // `.env` and its variants have an empty extension but are explicitly
          // exempted from the dotfile skip above; treat them as text files.
          const isEnvFile = entry.name.startsWith('.env');
          if (!isEnvFile && !TEXT_EXTENSIONS.has(ext)) {
            continue;
          }

          let content: string;
          try {
            content = await fs.readFile(fullPath, 'utf8');
          } catch {
            continue;
          }

          const lines = content.split(/\r?\n/u);
          const matches: Array<{ content: string; lineNumber: number; }> = [];

          for (const [lineIndex, line] of lines.entries()) {
            if (regex.test(line)) {
              matches.push({
                content: line.trim().slice(0, 120),
                lineNumber: lineIndex + 1,
              });
              totalMatches++;
            }

            regex.lastIndex = 0;
          }

          if (matches.length > 0) {
            const relativePath = path.relative(pathGuard.rootRealPath, fullPath);
            fileMatches.push({ filePath: relativePath, lines: matches });
          }
        }
      }

      try {
        await walk(pathGuard.rootRealPath);
      } catch (error) {
        return `[ERROR] Search failed: ${(error as Error).message}`;
      }

      if (fileMatches.length === 0) {
        return [
          `── search_codebase ── 0 matches ──`,
          `Pattern: ${regexPattern}`,
          ``,
          `No matches found. Suggestions:`,
          `- Try a simpler regex pattern`,
          `- Remove fileExtension filter if applied`,
          `- Use context_retrieval for semantic searches instead`,
        ].join('\n');
      }

      // Build grouped output: one block per file
      const maxFilesToShow = 15;
      const shownFiles = fileMatches.slice(0, maxFilesToShow);
      const omittedFiles = fileMatches.length - maxFilesToShow;

      const output: string[] = [
        `── search_codebase ── ${totalMatches} matches in ${fileMatches.length} files ──`,
        `Pattern: ${regexPattern}`,
        ``,
      ];

      for (const fm of shownFiles) {
        const matchCount = fm.lines.length;
        output.push(`📄 ${fm.filePath} — ${matchCount} match${matchCount === 1 ? '' : 'es'}`);

        // Show up to 5 matches per file, with line numbers
        const shownLines = fm.lines.slice(0, 5);
        for (const match of shownLines) {
          output.push(`   L${match.lineNumber}: ${match.content}`);
        }

        if (fm.lines.length > 5) {
          output.push(`   ... and ${fm.lines.length - 5} more matches`);
        }

        output.push('');
      }

      if (omittedFiles > 0) {
        output.push(`... and ${omittedFiles} more files with matches`, `💡 Narrow results with fileExtension filter or more specific regex.`, '');
      }

      // Chaining hint
      output.push(`── Next steps ──`, `• To inspect: read_file_content({ filePath: "<path>", startLine: <line-5>, endLine: <line+20> })`, `• To refine: search_codebase({ regexPattern: "<more specific>", fileExtension: ".ts" })`);

      return output.join('\n');
    },
    inputSchema: z.object({
      fileExtension: z.string().optional().describe('Optional extension filter (".ts", ".js", ".py").'),
      regexPattern: z
        .string()
        .max(200)
        .describe(String.raw`Regex pattern to search for (example: "eval\s*\(").`),
    }),
  };
}
