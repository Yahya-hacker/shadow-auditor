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

// Cross-process lockfile parameters. The in-process `pathLocks` map only
// serializes writers within a single process; multiple CLI processes sharing
// a workspace (the documented operating model) can otherwise overwrite each
// other's snapshot writes. A lockfile acquired with the exclusive 'wx' flag
// extends that serialization across processes.
const CROSS_PROCESS_LOCK_STALE_MS = 30_000;
const CROSS_PROCESS_LOCK_RETRY_MS = 25;
const CROSS_PROCESS_LOCK_TIMEOUT_MS = 10_000;

function lockFilePath(filePath: string): string {
  return `${filePath}.shadow-atomic-lock`;
}

/**
 * Acquire an exclusive cross-process lockfile for `filePath`. Uses `open(..., 'wx')`
 * so only one process can hold the lock at a time. A lockfile left behind by a
 * crashed process is detected via its mtime and stolen after it goes stale.
 * Returns a release function. Throws if the lock cannot be acquired within the
 * timeout (e.g. a live holder that never releases).
 */
async function acquireCrossProcessLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = lockFilePath(filePath);
  const deadline = Date.now() + CROSS_PROCESS_LOCK_TIMEOUT_MS;
  let handle: fs.FileHandle | undefined;

  while (Date.now() < deadline) {
    try {
      handle = await fs.open(lockPath, 'wx', SENSITIVE_FILE_MODE);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8');
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await handle?.close();
        } catch {
          // Best-effort close.
        }

        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      // Lock held by someone else. Steal it if it is stale.
      try {
        const stats = await fs.lstat(lockPath);
        if (Date.now() - stats.mtimeMs > CROSS_PROCESS_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        // Lockfile vanished between open and stat — retry immediately.
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, CROSS_PROCESS_LOCK_RETRY_MS);
      });
    }
  }

  throw new Error(
    `Timed out acquiring cross-process lock for ${filePath} (held by another process)`,
  );
}

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

  // The journal is the authoritative marker of a pending interrupted
  // replacement — it is written before the destination is moved aside and
  // removed only after the replacement either succeeds or is rolled back.
  // A backup file left behind WITHOUT a journal is not recovery state: it may
  // be a concurrent (non-atomic) writer's file that happens to share the
  // backup name. Acting on existence alone previously destroyed that file.
  let journalExists = false;
  try {
    const journalStats = await fs.lstat(journalPath);
    if (journalStats.isSymbolicLink() || !journalStats.isFile()) {
      throw new Error(`Refusing atomic recovery from non-regular journal: ${journalPath}`);
    }

    journalExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // No journal → nothing pending to recover. Never touch a stray backup file
  // that shares the deterministic backup name but is not recovery state.
  if (!journalExists) return;

  try {
    const backupStats = await fs.lstat(backupPath);
    if (backupStats.isSymbolicLink() || !backupStats.isFile()) {
      throw new Error(`Refusing atomic recovery from non-regular backup: ${backupPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Journal exists but the backup vanished (never moved aside) — nothing to
    // recover. Drop the orphaned journal so it cannot mislead later calls.
    await fs.rm(journalPath, { force: true });
    return;
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
    // Serialize against writers in *other* processes too. Acquired after the
    // in-process turn so queued calls within this process stay ordered and
    // only one process holds the lockfile while operating.
    const releaseCrossProcess = await acquireCrossProcessLock(filePath);
    try {
      return await operation();
    } finally {
      await releaseCrossProcess();
    }
  } finally {
    release?.();
    if (pathLocks.get(lockKey) === tail) pathLocks.delete(lockKey);
  }
}

// Windows can hold a directory handle for a few milliseconds after a spawned
// child process (git, a test runner, etc.) exits, so a single `fs.rm` can fail
// with EBUSY/EPERM/ENOTEMPTY. Retry with a short backoff before giving up.
const REMOVABLE_BUSY_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);

export async function removePathResilient(
  target: string,
  options: {force?: boolean; recursive?: boolean} = {},
  maxAttempts = 5,
): Promise<void> {
  const {force = true, recursive = true} = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.rm(target, {force, recursive});
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (!REMOVABLE_BUSY_CODES.has(code ?? '')) throw error;
      lastError = error;
      await new Promise<void>(resolve => {
        setTimeout(resolve, 50 * 2 ** attempt);
      });
    }
  }

  throw lastError;
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
