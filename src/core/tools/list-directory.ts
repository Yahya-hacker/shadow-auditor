import { tool } from 'ai';
import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { PathGuardError, type PathGuard } from '../policy/path-guard.js';

export function createListDirectoryTool(pathGuard: PathGuard) {
  return tool({
    description:
      'Lists directory contents using symlink-safe path resolution. Use this to discover files and repository layout.',
    inputSchema: z.object({
      path: z.string().describe('Relative directory path from repository root (use "." for root).'),
    }),
    async execute({ path: dirPath }: { path: string }) {
      try {
        const absolutePath = await pathGuard.resolveExistingPath(dirPath);
        const stat = await fs.stat(absolutePath);
        if (!stat.isDirectory()) {
          return `[ERROR] "${dirPath}" is not a directory.`;
        }

        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const formatted = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`)
          .join('\n');

        const relative = pathGuard.toRelative(absolutePath) || '.';
        return `// ─── DIRECTORY: ${relative} ───\n${formatted || '[EMPTY]'}`;
      } catch (error) {
        if (error instanceof PathGuardError) {
          return `[ERROR] ${error.message}`;
        }

        if ((error as { code?: string }).code === 'ENOENT') {
          return `[ERROR] Could not list directory "${dirPath}": path does not exist.`;
        }

        return `[ERROR] Could not list directory "${dirPath}": ${(error as Error).message}`;
      }
    },
  });
}
