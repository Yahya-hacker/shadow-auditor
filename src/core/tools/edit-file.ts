import { Command } from '@langchain/langgraph';
import * as fs from 'node:fs/promises';
import { z } from 'zod';

import type { HumanInteractionService } from '../../utils/human-in-loop.js';

import { recoverAtomicWrite, writeFileAtomic } from '../../utils/fs-atomic.js';
import { type PathGuard, PathGuardError } from '../policy/path-guard.js';

export function createEditFileTool(pathGuard: PathGuard, humanInteraction: HumanInteractionService) {
  return {
    description:
      'Proposes and applies a patch to a file. Requires user confirmation before writing changes. ' +
      'Provide the EXACT target code to replace and the replacement code.\n\n' +
      'USAGE: { filePath: "src/auth/login.ts", targetCode: "const q = \\"SELECT * FROM users WHERE id=\\" + userId", replacementCode: "const q = \\"SELECT * FROM users WHERE id=?\\"; // use parameterized query" }\n' +
      'NOTE: If target code is not found (exact match required), the tool will error. Re-read the file and try again.\n' +
      'CONFIRMATION: The user will be prompted to approve or deny this edit before it is applied.',
    async execute({
      filePath,
      replacementCode,
      targetCode,
    }: {
      filePath: string;
      replacementCode: string;
      targetCode: string;
    }) {
      try {
        if (targetCode.length === 0) {
          return '[ERROR] Target code must not be empty.';
        }

        const absolutePath = await pathGuard.resolvePathForWrite(filePath);
        await recoverAtomicWrite(absolutePath);
        const initialStats = await fs.lstat(absolutePath);
        if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
          return `[ERROR] Refusing to edit non-regular file "${filePath}".`;
        }

        const content = await fs.readFile(absolutePath, 'utf8');
        if (!content.includes(targetCode)) {
          return [
            `── edit_file ── FAILED: ${filePath} ──`,
            `[ERROR] Target code not found in "${filePath}".`,
            `The exact snippet provided was not found in the file.`,
            `💡 Re-read the file with read_file_content to get the exact current code, then try again.`,
          ].join('\n');
        }

        // Request human confirmation. In LangGraph context this throws a Command
        // (interrupting the graph at HumanIntervention). On resume, the tool is
        // called again and this returns true. Outside a compiled graph, this
        // returns the blocking confirmation result.
        const confirmed = await humanInteraction.confirmFileEdit(filePath, targetCode, replacementCode);
        if (!confirmed) {
          return `── edit_file ── DENIED ──\n[DENIED] User denied file edit: "${filePath}".`;
        }

        // ── TOCTOU mitigation ──────────────────────────────────────────
        // Re-read the file after confirmation to detect concurrent changes.
        // If the file changed between the initial read and now, compute a
        // hash of the original and re-check. This prevents silent corruption
        // when another process (or agent worker) modified the file while the
        // confirmation dialog was open.
        await recoverAtomicWrite(absolutePath);
        const freshStats = await fs.lstat(absolutePath);
        if (freshStats.isSymbolicLink() || !freshStats.isFile()) {
          return `[ERROR] Refusing to edit non-regular file "${filePath}".`;
        }

        const freshContent = await fs.readFile(absolutePath, 'utf8');
        if (freshContent === content) {
          const nextContent = content.replace(targetCode, replacementCode);
          await writeFileAtomic(absolutePath, nextContent);
        } else {
          // Content changed since our initial read — verify target still exists
          if (!freshContent.includes(targetCode)) {
            return [
              `── edit_file ── FAILED: ${filePath} ──`,
              `[ERROR] File was modified by another process while awaiting confirmation.`,
              `The target code no longer exists in the current version of the file.`,
              `💡 Re-read the file and try again with the updated content.`,
            ].join('\n');
          }

          // Target still exists — use the fresh content as the base
          const nextContent = freshContent.replace(targetCode, replacementCode);
          await writeFileAtomic(absolutePath, nextContent);
        }

        return [
          `── edit_file ── SUCCESS: ${filePath} ──`,
          `[SUCCESS] Patch applied to "${filePath}".`,
          `Lines changed: ${targetCode.split('\n').length} removed, ${replacementCode.split('\n').length} added.`,
        ].join('\n');
      } catch (error) {
        if (error instanceof Command) {
          throw error;
        }

        if (error instanceof PathGuardError) {
          return `[ERROR] ${error.message}`;
        }

        return `[ERROR] Could not edit file "${filePath}": ${(error as Error).message}`;
      }
    },
    inputSchema: z.object({
      filePath: z.string().describe('Relative file path from repository root.'),
      replacementCode: z.string().describe('Replacement code to write into the file.'),
      targetCode: z.string().min(1).describe('Exact non-empty code snippet to replace.'),
    }),
  };
}
