import { tool } from 'ai';
import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { confirmFileEdit } from '../../utils/human-in-loop.js';
import { PathGuardError, type PathGuard } from '../policy/path-guard.js';

export function createEditFileTool(pathGuard: PathGuard) {
  return tool({
    description:
      'Proposes and applies a patch to a file. Requires user confirmation before writing changes.',
    inputSchema: z.object({
      filePath: z.string().describe('Relative file path from repository root.'),
      replacementCode: z.string().describe('Replacement code to write into the file.'),
      targetCode: z.string().describe('Exact code snippet to replace.'),
    }),
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
          return `[ERROR] Target code not found in "${filePath}". Read the file again and provide the exact snippet.`;
        }

        const confirmed = await confirmFileEdit(filePath, targetCode, replacementCode);
        if (!confirmed) {
          return `[DENIED] User denied patch for "${filePath}".`;
        }

        const nextContent = content.replace(targetCode, replacementCode);
        await fs.writeFile(absolutePath, nextContent, 'utf8');
        return `[SUCCESS] Patch applied to "${filePath}".`;
      } catch (error) {
        if (error instanceof PathGuardError) {
          return `[ERROR] ${error.message}`;
        }

        return `[ERROR] Could not edit file "${filePath}": ${(error as Error).message}`;
      }
    },
  });
}
