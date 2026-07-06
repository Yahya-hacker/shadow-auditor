import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG_DIR = path.join(process.cwd(), '.shadow-auditor');
const LOG_FILE = path.join(LOG_DIR, 'shadow_debug.log');

let lastLogTime = 0;
const THROTTLE_MS = 100;

/**
 * Throttled debug logger that writes to an external file (shadow_debug.log).
 * 
 * Strictly forbids console.log() or process.stdout.write() to prevent
 * ANSI byte collisions and stdout race conditions with Ink's renderer.
 * Throttled to a maximum of 100ms intervals to prevent I/O bottlenecks
 * during high-frequency Blackboard/Swarm updates.
 */
export function debugLog(message: string): void {
  const now = Date.now();
  if (now - lastLogTime < THROTTLE_MS) {
    return;
  }

  lastLogTime = now;

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`, 'utf8');
  } catch {
    // Silently fail to avoid crashing the agent or interfering with the TUI
  }
}
