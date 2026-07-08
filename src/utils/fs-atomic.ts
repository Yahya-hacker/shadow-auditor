/**
 * Filesystem atomic operations — writes to a temp file then renames,
 * preventing partial/corrupt files if the process crashes mid-write.
 *
 * File permissions are set to 0o600 (owner read/write only) to protect
 * sensitive data like API keys in config files.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';

const SENSITIVE_FILE_MODE = 0o600;

/**
 * Write content to `filePath` atomically: write to a temp file first,
 * then rename. Uses a random suffix to avoid collisions on concurrent
 * writes to the same path (e.g., rapid SARIF + JSON + MD generation).
 * On rename failure (cross-device, permissions), falls back to
 * delete-then-rename.
 *
 * The temp file is created with 0o600 permissions to prevent other
 * users on the system from reading sensitive content (API keys, tokens)
 * during the window between write and rename.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: SENSITIVE_FILE_MODE });
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
  // Ensure the final file also has restrictive permissions
  try {
    await fs.chmod(filePath, SENSITIVE_FILE_MODE);
  } catch {
    // Best-effort: chmod may fail on some filesystems (e.g., FAT32)
  }
}
