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

const DEFAULT_ALLOWED_PATTERNS = [
  /^\s*git\s+(status|diff|log)(\s|$)/i,
  /^\s*npm\s+(test|run\s+(test|lint|build)|run-script\s+(test|lint|build)|run\s+lint|run\s+build)(\s|$)/i,
  // Read-only Unix analysis tools safe for security auditing (may be piped together)
  /^\s*(grep|egrep|fgrep|rg)\b/i,
  /^\s*find\s+/i,
  /^\s*(cat|head|tail|wc|file|stat)\s+/i,
  /^\s*(ls|ls\s+-\S+)\b/i,
  /^\s*(echo|printf)\b/i,
  /^\s*sed\b/i,
  /^\s*awk\b/i,
  /^\s*jq\b/i,
  /^\s*(sort|uniq|cut|tr|diff|comm)\b/i,
  /^\s*tree\b/i,
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

export function evaluateCommandPolicy(command: string, config: CommandPolicyConfig = {}): CommandPolicyDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: false,
      reason: '[POLICY_DENIED] Empty command is not allowed.',
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

  const matchedAllow = allowPatterns.find((pattern) => pattern.test(trimmed));
  if (matchedAllow) {
    return {
      allowed: true,
      reason: '[POLICY_ALLOWED] Command is allowed by policy.',
      ...(matchedDeny
        ? {
            warning:
              '[EXPERT-UNSAFE] This command matches a dangerous pattern but expert mode is enabled. Confirm carefully.',
          }
        : {}),
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
      '[POLICY_DENIED] Command family is not allowlisted. Allowed families: git status|diff|log, npm test|run lint|run build.',
  };
}
