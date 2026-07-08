/**
 * Filesystem atomic operations — writes to a temp file then renames,
 * preventing partial/corrupt files if the process crashes mid-write.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';

/**
 * Write content to `filePath` atomically: write to a temp file first,
 * then rename. Uses a random suffix to avoid collisions on concurrent
 * writes to the same path (e.g., rapid SARIF + JSON + MD generation).
 * On rename failure (cross-device, permissions), falls back to
 * delete-then-rename.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    const renameError = error as NodeJS.ErrnoException;
    if (renameError.code === 'EEXIST' || renameError.code === 'EPERM') {
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
      return;
    }
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}
