import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { confirmFileEdit } from '../../utils/human-in-loop.js';
import { type PathGuard, PathGuardError } from '../policy/path-guard.js';

export function createEditFileTool(pathGuard: PathGuard) {
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
        const absolutePath = await pathGuard.resolvePathForWrite(filePath);
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
        // called again and this returns true. In non-LangGraph context (Vercel AI
        // SDK swarm mode), returns the blocking confirmation result.
        const confirmed = await confirmFileEdit(filePath, targetCode, replacementCode);
        if (!confirmed) {
          return `── edit_file ── DENIED ──\n[DENIED] User denied file edit: "${filePath}".`;
        }

        const nextContent = content.replace(targetCode, replacementCode);
        await fs.writeFile(absolutePath, nextContent, 'utf8');
        return [
          `── edit_file ── SUCCESS: ${filePath} ──`,
          `[SUCCESS] Patch applied to "${filePath}".`,
          `Lines changed: ${targetCode.split('\n').length} removed, ${replacementCode.split('\n').length} added.`,
        ].join('\n');
      } catch (error) {
        if (error instanceof PathGuardError) {
          return `[ERROR] ${error.message}`;
        }

        return `[ERROR] Could not edit file "${filePath}": ${(error as Error).message}`;
      }
    },
    inputSchema: z.object({
      filePath: z.string().describe('Relative file path from repository root.'),
      replacementCode: z.string().describe('Replacement code to write into the file.'),
      targetCode: z.string().describe('Exact code snippet to replace.'),
    }),
  };
}
