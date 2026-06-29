import { tool } from 'ai';
import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { type PathGuard, PathGuardError } from '../policy/path-guard.js';

export function createReadFileTool(pathGuard: PathGuard) {
  return tool({
    description:
      'Reads full source code from a repository file using hardened path guards. Use this for implementation-level security analysis.',
    async execute({ filePath }: { filePath: string }) {
      try {
        const absolutePath = await pathGuard.resolveExistingPath(filePath);
        const content = await fs.readFile(absolutePath, 'utf8');
        const relativePath = pathGuard.toRelative(absolutePath);
        return `// ─── FILE: ${relativePath} ───\n${content}`;
      } catch (error) {
        if (error instanceof PathGuardError) {
          return `[ERROR] ${error.message}`;
        }

        return `[ERROR] Could not read file "${filePath}": ${(error as Error).message}`;
      }
    },
    inputSchema: z.object({
      filePath: z.string().describe('Relative file path from the repository root.'),
    }),
  });
}
