import { RunArtifacts } from './core/run-artifacts.js';

const DEFAULT_COMMAND = 'shell';
const EXPLICIT_COMMANDS = new Set(['help', 'shell']);
const ROOT_FLAGS = new Set(['--version']);

/**
 * oclif v4 string flags require a value, so a bare `--resume` (no value)
 * cannot be declared as a normal flag. Translate `--resume` into the already
 * existing `--resume-run` flag:
 *  - `--resume <id>`  → `--resume-run <id>`
 *  - bare `--resume`  → `--resume-run <most recent run id for the target>`
 */
function normalizeResumeFlag(argv: string[]): string[] {
  const routed = [...argv];
  for (let i = 0; i < routed.length; i++) {
    if (routed[i] !== '--resume') continue;

    const next = routed[i + 1];
    const hasValue = next !== undefined && !next.startsWith('-');
    if (hasValue) {
      // `--resume <id>` → `--resume-run <id>`
      routed.splice(i, 2, '--resume-run', next);
    } else {
      // Bare `--resume` → resolve most recent run for this target.
      const basePath = process.cwd();
      const mostRecent = RunArtifacts.findMostRecentRunIdSync(basePath);
      if (mostRecent) {
        routed.splice(i, 1, '--resume-run', mostRecent);
      } else {
        throw new Error(
          'No previous session found to resume. Run `shadow-auditor` to start a fresh audit.',
        );
      }
    }
  }

  return routed;
}

export function routeDefaultCommand(argv: string[]): string[] {
  const routed = normalizeResumeFlag(argv);
  if (routed[2] === '-v') routed[2] = '--version';
  const firstArgument = routed[2];

  if (
    firstArgument === undefined ||
    (!EXPLICIT_COMMANDS.has(firstArgument) && !ROOT_FLAGS.has(firstArgument))
  ) {
    routed.splice(2, 0, DEFAULT_COMMAND);
  }

  return routed;
}
