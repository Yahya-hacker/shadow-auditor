import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { type PathGuard, PathGuardError } from '../policy/path-guard.js';

export function createListDirectoryTool(pathGuard: PathGuard) {
  return {
    description:
      'Lists directory contents using symlink-safe path resolution. ' +
      'Use this to discover files and understand repository layout before targeted searches.\n\n' +
      'USAGE: { path: "src/controllers" } or { path: "." } for root\n' +
      'CHAIN: After listing a directory, use read_file_content or search_codebase on interesting files.\n' +
      'TIP: Use "." to get an overview of the project root structure.',
    async execute({ path: dirPath }: { path: string }) {
      try {
        const absolutePath = await pathGuard.resolveExistingPath(dirPath);
        const stat = await fs.stat(absolutePath);
        if (!stat.isDirectory()) {
          return `[ERROR] "${dirPath}" is not a directory.`;
        }

        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
        const relative = pathGuard.toRelative(absolutePath) || '.';

        const dirs = sorted.filter((e) => e.isDirectory());
        const files = sorted.filter((e) => e.isFile());

        const lines: string[] = [
          `── list_directory ── ${relative} ── ${entries.length} entries (${dirs.length} dirs, ${files.length} files) ──`,
        ];

        // Directories first
        if (dirs.length > 0) {
          lines.push('');
          lines.push('📁 Directories:');
          for (const d of dirs) {
            lines.push(`   📁 ${d.name}/`);
          }
        }

        // Files
        if (files.length > 0) {
          lines.push('');
          lines.push('📄 Files:');
          // Show up to 50 files; note if there are more
          const shown = files.slice(0, 50);
          for (const f of shown) {
            lines.push(`   📄 ${f.name}`);
          }
          if (files.length > 50) {
            lines.push(`   ... and ${files.length - 50} more files`);
            lines.push(`   💡 Use fileExtension filter with search_codebase or context_retrieval to narrow.`);
          }
        }

        if (entries.length === 0) {
          lines.push('');
          lines.push('[EMPTY]');
        }

        // Chaining hint
        if (files.length > 0) {
          lines.push('');
          lines.push(`── Next steps ──`);
          lines.push(`• Search: context_retrieval({ query: "<vuln pattern in this directory>" })`);
          lines.push(`• Inspect: read_file_content({ filePath: "${relative !== '.' ? relative + '/' : ''}<filename>", startLine: 1, endLine: 80 })`);
        }

        return lines.join('\n');
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
    inputSchema: z.object({
      path: z.string().describe('Relative directory path from repository root (use "." for root).'),
    }),
  };
}
