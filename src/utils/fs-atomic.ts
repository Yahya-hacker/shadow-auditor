/**
 * Filesystem atomic operations — writes to a temp file then renames,
 * preventing partial/corrupt files if the process crashes mid-write.
 *
 * File permissions are set to 0o600 (owner read/write only) to protect
 * sensitive data like API keys in config files.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SENSITIVE_FILE_MODE = 0o600;
const pathLocks = new Map<string, Promise<void>>();

function recoveryPaths(filePath: string): { backupPath: string; journalPath: string } {
  return {
    backupPath: `${filePath}.shadow-atomic-backup`,
    journalPath: `${filePath}.shadow-atomic-journal`,
  };
}

/**
 * Repair an interrupted replacement before a canonical file is read or
 * overwritten. The deterministic backup name makes the crash state
 * discoverable by a later process.
 */
async function recoverAtomicWriteUnlocked(filePath: string): Promise<void> {
  const { backupPath, journalPath } = recoveryPaths(filePath);
  try {
    const backupStats = await fs.lstat(backupPath);
    if (backupStats.isSymbolicLink() || !backupStats.isFile()) {
      throw new Error(`Refusing atomic recovery from non-regular backup: ${backupPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.rm(journalPath, { force: true });
    return;
  }

  try {
    const journalStats = await fs.lstat(journalPath);
    if (journalStats.isSymbolicLink() || !journalStats.isFile()) {
      throw new Error(`Refusing atomic recovery from non-regular journal: ${journalPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    const destinationStats = await fs.lstat(filePath);
    if (destinationStats.isSymbolicLink() || !destinationStats.isFile()) {
      throw new Error(`Refusing atomic recovery of non-regular destination: ${filePath}`);
    }

    await fs.rm(backupPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.rename(backupPath, filePath);
  }

  await fs.rm(journalPath, { force: true });
}

export async function recoverAtomicWrite(filePath: string): Promise<void> {
  await withPathLock(filePath, () => recoverAtomicWriteUnlocked(filePath));
}

/**
 * Write content to `filePath` atomically: write to a temp file first,
 * then rename. Uses a random suffix to avoid collisions on concurrent
 * writes to the same path (e.g., rapid SARIF + JSON + MD generation).
 * On Windows rename conflicts, moves the existing destination to a backup and
 * restores it if replacement fails.
 *
 * The temp file is created with 0o600 permissions to prevent other
 * users on the system from reading sensitive content (API keys, tokens)
 * during the window between write and rename.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await withPathLock(filePath, async () => {
    await recoverAtomicWriteUnlocked(filePath);
    let finalMode = SENSITIVE_FILE_MODE;
    try {
      const destinationStats = await fs.lstat(filePath);
      if (destinationStats.isSymbolicLink() || !destinationStats.isFile()) {
        throw new Error(`Refusing atomic write to non-regular destination: ${filePath}`);
      }

      finalMode = destinationStats.mode % 0o1000;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: finalMode });
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const renameError = error as NodeJS.ErrnoException;
      if (renameError.code === 'EEXIST' || renameError.code === 'EPERM') {
        const { backupPath, journalPath } = recoveryPaths(filePath);
        let backedUp = false;
        try {
          await fs.writeFile(journalPath, JSON.stringify({ filePath, tempPath }), {
            encoding: 'utf8',
            mode: SENSITIVE_FILE_MODE,
          });
          await fs.rename(filePath, backupPath);
          backedUp = true;
          await fs.rename(tempPath, filePath);
          await fs.rm(backupPath, { force: true });
          await fs.rm(journalPath, { force: true });
        } catch (replacementError) {
          if (backedUp) {
            await restoreBackup(filePath, backupPath, replacementError);
          }

          await fs.rm(journalPath, { force: true });
          await fs.rm(tempPath, { force: true });
          throw replacementError;
        }
      } else {
        await fs.rm(tempPath, { force: true });
        throw error;
      }
    }

    // Ensure the final file also has restrictive permissions
    try {
      await fs.chmod(filePath, finalMode);
    } catch {
      // Best-effort: chmod may fail on some filesystems (e.g., FAT32)
    }
  });
}

export async function withPathLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockKey = path.resolve(filePath);
  const previous = pathLocks.get(lockKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  pathLocks.set(lockKey, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (pathLocks.get(lockKey) === tail) pathLocks.delete(lockKey);
  }
}

async function restoreBackup(
  filePath: string,
  backupPath: string,
  replacementError: unknown,
): Promise<void> {
  try {
    await fs.rename(backupPath, filePath);
  } catch (restoreError) {
    throw new AggregateError(
      [replacementError, restoreError],
      `Atomic replacement and recovery both failed for ${filePath}`,
    );
  }
}
