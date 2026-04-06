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
];

const PNPM_YARN_ALLOWED_PATTERNS = [
  /^\s*pnpm\s+(test|lint|build|run\s+(test|lint|build))(\s|$)/i,
  /^\s*yarn\s+(test|lint|build|run\s+(test|lint|build))(\s|$)/i,
];

const DEFAULT_DENIED_PATTERNS = [
  /(^|[;&|]\s*)rm\s+-rf(\s|$)/i,
  /(^|[;&|]\s*)del(\.exe)?\s+\/s(\s|$)/i,
  /\b(sudo|doas|su)\b/i,
  /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash|zsh|fish|pwsh|powershell)\b/i,
  /\b(apt(-get)?|yum|dnf|pacman|zypper|brew|choco)\s+(install|remove|upgrade|update)\b/i,
  /\b(chmod\s+777|chown\s+-R)\b/i,
  /\b(mkfs(\.\w+)?|fdisk|diskpart|format)\b/i,
  /\b(shutdown|reboot|halt)\b/i,
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
