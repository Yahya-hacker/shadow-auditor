import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const LOG_DIR = path.join(process.cwd(), '.shadow-auditor');
const LOG_FILE = path.join(LOG_DIR, 'shadow_debug.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB rotation threshold
const THROTTLE_MS = 100;

/**
 * Debug logger with per-instance state (no module-level mutable globals).
 *
 * Each instance carries its own `lastLogTime` and `logInitialized` flag,
 * so independent test harnesses or parallel workers can each hold their
 * own logger without cross-contamination.
 */
export class DebugLogger {
  private lastLogTime = 0;
  private logInitialized = false;

  /**
   * Throttled debug log write.
   *
   * Strictly forbids console.log() or process.stdout.write() to prevent
   * ANSI byte collisions and stdout race conditions with Ink's renderer.
   * Throttled to a maximum of 100ms intervals to prevent I/O bottlenecks
   * during high-frequency Blackboard/Swarm updates.
   *
   * Fully async: uses fs/promises with non-blocking I/O.
   * Includes automatic log rotation at 5 MB, keeping up to 3 rotated files.
   */
  async log(message: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastLogTime < THROTTLE_MS) {
      return;
    }

    this.lastLogTime = now;

    try {
      await this.ensureLogDir();
      await this.rotateIfNeeded();

      const timestamp = new Date().toISOString();
      await fs.appendFile(LOG_FILE, `[${timestamp}] ${message}\n`, 'utf8');
    } catch {
      // Silently fail to avoid crashing the agent or interfering with the TUI
    }
  }

  /**
   * Ensure the log directory exists. Called lazily on first write.
   */
  private async ensureLogDir(): Promise<void> {
    if (this.logInitialized) return;
    this.logInitialized = true;
    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
    } catch {
      // Silently fail — logging is best-effort
    }
  }

  /**
   * Rotate the log file if it exceeds the maximum size.
   * Renames current file to .1, .2, etc. (max 3 rotation files).
   */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        // Shift rotation chain: .2 -> .3, .1 -> .2, current -> .1
        for (let i = 2; i >= 1; i--) {
          const oldPath = `${LOG_FILE}.${i}`;
          const newPath = `${LOG_FILE}.${i + 1}`;
          try {
            if (i === 2) {
              await fs.rm(newPath, { force: true });
            }

            await fs.rename(oldPath, newPath);
          } catch {
            // Rotation file may not exist yet — that's fine
          }
        }

        await fs.rename(LOG_FILE, `${LOG_FILE}.1`);
      }
    } catch {
      // File may not exist yet — that's fine
    }
  }
}

/**
 * Default singleton instance for backward compatibility.
 * Existing callers that import `debugLog` continue to work unchanged.
 */
const defaultLogger = new DebugLogger();

/**
 * Throttled debug logger that writes to an external file (shadow_debug.log).
 *
 * Strictly forbids console.log() or process.stdout.write() to prevent
 * ANSI byte collisions and stdout race conditions with Ink's renderer.
 * Throttled to a maximum of 100ms intervals to prevent I/O bottlenecks
 * during high-frequency Blackboard/Swarm updates.
 *
 * Now fully async: uses fs/promises with non-blocking I/O.
 * Includes automatic log rotation at 5 MB, keeping up to 3 rotated files.
 */
export async function debugLog(message: string): Promise<void> {
  return defaultLogger.log(message);
}
