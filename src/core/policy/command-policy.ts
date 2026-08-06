export interface CommandPolicyConfig {
  additionalAllowedCommandPatterns?: string[];
  additionalDeniedPatterns?: string[];
  allowPnpmYarn?: boolean;
  expertUnsafe?: boolean;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  reason: string;
  warning?: string;
}

export function hardenAllowedCommand(command: string): string {
  return command.replace(
    /^(\s*git\s+(?:diff|log))\b/i,
    '$1 --no-ext-diff --no-textconv',
  );
}

const DEFAULT_ALLOWED_PATTERNS = [
  /^\s*git\s+(status|diff|log)(\s|$)/i,
  // Non-programmable repository discovery tools. File reads should use
  // PathGuard-backed native tools instead of the host shell.
  /^\s*rg\b/i,
  /^\s*find\s+/i,
  /^\s*(echo|printf)\b/i,
];

const UNSAFE_FIND_ACTIONS =
  /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|files0-from|fls|fprint|fprint0|fprintf)(?:\s|=|$)/i;
const HOST_PATH_ARGUMENT =
  /(?:^|[\s=])["']?(?:\/|~(?:\/|$)|[a-z]:[\\/]|\\\\|\.\.(?:[\\/]|$))/i;
const UNSAFE_ANALYSIS_OPTIONS = [
  /(?:^|\s)(?:--pre(?:-glob)?|--hostname-bin|-L|--follow)(?:\s|=|$)/i,
  /(?:^|\s)find\s+(?:-H|-L|-P)(?:\s|$)/i,
  /(?:^|\s)tree\b[^\n]*(?:\s-l|\s--follow)(?:\s|$)/i,
];

const PNPM_YARN_ALLOWED_PATTERNS = [
  /^\s*pnpm\s+(test|lint|build|run\s+(test|lint|build))(\s|$)/i,
  /^\s*yarn\s+(test|lint|build|run\s+(test|lint|build))(\s|$)/i,
];

const DEFAULT_DENIED_PATTERNS = [
  // Destructive file operations (only when explicit, e.g. not inside a pipe)
  /(^|[;&|]\s*)rm\s+-rf(\s|$)/i,
  /(^|[;&|]\s*)del(\.exe)?\s+\/s(\s|$)/i,
  // Privilege escalation
  /\b(sudo|doas|su)\b/i,
  // Curl/wget piping to shell (remote code execution)
  /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash|zsh|fish|pwsh|powershell)\b/i,
  // Package manager install/remove (could install malicious packages)
  /\b(apt(-get)?|yum|dnf|pacman|zypper|brew|choco)\s+(install|remove|upgrade|update)\b/i,
  // Permission/ownership escalation
  /\b(chmod\s+777|chown\s+-R)\b/i,
  // Filesystem formatting/destruction
  /\b(mkfs(\.\w+)?|fdisk|diskpart|format)\b/i,
  // System shutdown
  /\b(shutdown|reboot|halt)\b/i,
  // Base64 encoded payloads (used to smuggle commands past allowlists)
  /\bbase64\s+(-d|--decode)\b/i,
  /\bopenssl\s+base64\b/i,
  // Nested subshells (could hide arbitrary commands)
  /\$\(/,
  // Environment expansion can resolve otherwise-hidden host paths.
  /\$(?:\{[^}]+\}|[a-z_]\w*|[0-9@*#?$!-])/i,
  /`[^`]*`/,
  // Process substitution (bash-specific bypass vector)
  /<\(/,
  />\(/,
  // Hex escape sequences (used to encode malicious strings)
  /\\x[0-9a-fA-F]{2}/,
  // Octal / ANSI-C quoting ($'...')
  /\$'[^']*'/,
];

/**
 * Shell substitution patterns that could hide dangerous commands inside
 * otherwise-allowed commands (e.g. `echo $(rm -rf /)`). These are checked
 * BEFORE the allowed/denied pattern matching.
 */
const SHELL_SUBSTITUTION_DANGEROUS = [
  // Command substitution containing destructive or privileged operations
  /(?:\$\(|`)\s*(?:rm\s+-rf|sudo|doas|su|mkfs|fdisk|shutdown|reboot|chmod\s+777|curl.*\|.*sh)/i,
];

function buildPatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  return patterns.map((pattern) => new RegExp(pattern, 'i'));
}

function inspectShellComposition(command: string): { pipeline: string[]; unsafe: boolean } {
  const pipeline: string[] = [];
  let segmentStart = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === '\\' && quote !== "'") {
      index++;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (quote) continue;
    if (char === '\n' || char === '\r' || char === ';' || char === '>') {
      return { pipeline: [], unsafe: true };
    }

    if (char === '<') {
      if (command.slice(index, index + 3) === '<<<') {
        index += 2;
        continue;
      }

      return { pipeline: [], unsafe: true };
    }

    if (char === '&') {
      return { pipeline: [], unsafe: true };
    }

    if (char === '|') {
      if (command[index + 1] === '|') return { pipeline: [], unsafe: true };
      pipeline.push(command.slice(segmentStart, index).trim());
      segmentStart = index + 1;
    }
  }

  pipeline.push(command.slice(segmentStart).trim());
  return { pipeline, unsafe: quote !== null };
}

export function evaluateCommandPolicy(command: string, config: CommandPolicyConfig = {}): CommandPolicyDecision {
  const trimmed = command.trim();

  if (!trimmed) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] Empty command is not allowed.',
    };
  }

  // Safe mode accepts one command or a pipeline of independently allowlisted
  // read-only commands. Other shell composition is rejected before regex
  // matching so an allowlisted prefix cannot smuggle a second command.
  const composition = inspectShellComposition(trimmed);
  const unsafeComposition = composition.unsafe;
  if (unsafeComposition && !config.expertUnsafe) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] Multiline commands, redirection, and shell chaining are not allowed in safe mode.',
    };
  }

  if (!config.expertUnsafe && HOST_PATH_ARGUMENT.test(trimmed)) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] Absolute, home-relative, and parent-traversal paths are not allowed in safe mode.',
    };
  }

  if (!config.expertUnsafe && UNSAFE_ANALYSIS_OPTIONS.some((pattern) => pattern.test(trimmed))) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] Options that execute subprocesses or follow links are not allowed in safe mode.',
    };
  }

  // Command-specific restrictions apply independently to every pipeline stage.
  if (
    !config.expertUnsafe &&
    composition.pipeline.some((segment) =>
      /^find(?:\s|$)/i.test(segment) && UNSAFE_FIND_ACTIONS.test(segment)
    )
  ) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] find executable, mutating, and file-writing actions are not allowed in safe mode.',
    };
  }

  // ── Shell substitution check (before pattern matching) ────────────
  // Prevent `echo $(rm -rf /)` and similar command-injection bypasses
  // where dangerous commands are hidden inside $() or backticks.
  const matchedSub = SHELL_SUBSTITUTION_DANGEROUS.find((p) => p.test(trimmed));
  if (matchedSub && !config.expertUnsafe) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] Command contains dangerous operations inside shell substitution ($(...) or backticks).',
      warning: 'Shell substitution with destructive commands is not permitted.',
    };
  }

  const deniedPatterns = [...DEFAULT_DENIED_PATTERNS, ...buildPatterns(config.additionalDeniedPatterns)];
  const matchedDeny = deniedPatterns.find((pattern) => pattern.test(trimmed));
  if (matchedDeny && !config.expertUnsafe) {
    return {
      allowed: false,
      reason: `[POLICY_DENIED] Command blocked by security policy (${matchedDeny.source}).`,
    };
  }

  const allowPatterns = [
    ...DEFAULT_ALLOWED_PATTERNS,
    ...(config.allowPnpmYarn ? PNPM_YARN_ALLOWED_PATTERNS : []),
    ...buildPatterns(config.additionalAllowedCommandPatterns),
  ];

  if (!config.expertUnsafe && composition.pipeline.length > 1) {
    const pipeline = composition.pipeline;
    if (
      pipeline.some((segment) =>
        !segment || !allowPatterns.some((pattern) => pattern.test(segment)),
      )
    ) {

      return {
        allowed: false,
        reason: '[POLICY_DENIED] Every command in a pipeline must be independently allowlisted.',
      };
    }
  }

  const matchedAllow = allowPatterns.find((pattern) => pattern.test(trimmed));
  if (matchedAllow) {
    return {
      allowed: true,
      reason: '[POLICY_ALLOWED] Command is allowed by policy.',
      warning: matchedDeny || unsafeComposition
        ? '[EXPERT-UNSAFE] This command uses dangerous syntax or matches a dangerous pattern. Confirm carefully.'
        : '[HOST-EXECUTION] This command will run on the host with the auditor process privileges. Confirm the command and every referenced path.',
    };
  }

  if (config.expertUnsafe) {
    return {
      allowed: true,
      reason: '[POLICY_ALLOWED] Command allowed in expert unsafe mode.',
      warning:
        '[EXPERT-UNSAFE] Command is outside the safe allowlist. Proceed only if you fully understand the impact.',
    };
  }

  return {
    allowed: false,
    reason:
      '[POLICY_DENIED] Command family is not allowlisted. Lifecycle scripts and programmable text processors require expert unsafe mode.',
  };
}
