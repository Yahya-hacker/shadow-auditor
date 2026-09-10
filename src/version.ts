import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'shadow-auditor';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

let cachedVersion: string | undefined;

/**
 * Resolve the tool's package version exactly once, walking up from this
 * module's location so it works from source (tests/ts-node), compiled
 * output (dist/), and globally installed or bundled layouts alike.
 */
export function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;

  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 20; depth += 1) {
    const candidate = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {name?: unknown; version?: unknown};
      if (parsed.name === PACKAGE_NAME &&
        typeof parsed.version === 'string' &&
        VERSION_PATTERN.test(parsed.version)) {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      // Not a package directory or unreadable — keep walking up.
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  cachedVersion = 'unknown';
  return cachedVersion;
}