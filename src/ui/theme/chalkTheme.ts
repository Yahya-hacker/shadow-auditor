import chalk from 'chalk';

/**
 * Premium terminal color theme using Chalk.
 *
 * Ink components should use the semantic `colors` object (ink-compatible names).
 * Raw strings / borders / spinners should use the `chalkTheme` helpers below.
 */

export const colors = {
  agent: 'cyan',
  border: 'magenta',
  borderError: 'red',
  borderSecondary: 'blue',
  borderWarning: 'yellow',
  brand: 'magenta',
  bright: '#ffffff',
  dim: '#666666',
  error: 'red',
  info: 'blue',
  muted: '#888888',
  pending: 'yellow',
  success: 'green',
  system: 'blue',
  user: 'green',
  warning: 'yellow',
} as const;

export const labels = {
  appName: 'Shadow Auditor',
  appTagline: 'Autonomous AI-Powered Security Analysis',
  shellTitle: 'Interactive Security Analysis Shell',
  version: 'v1.0.0',
} as const;

export const spacing = {
  inputPadX: 1,
  panelPadX: 2,
  panelPadY: 1,
  sectionMargin: 1,
} as const;

export const rolePrefix = {
  agent: '◆',
  error: '✖',
  streaming: '▍',
  system: '●',
  tool: '▶',
  toolDone: '✓',
  user: '❯',
} as const;

export const chalkTheme = {
  agent: chalk.cyan,
  brand: chalk.magenta.bold,
  dim: chalk.gray,
  error: chalk.red,
  errorBold: chalk.red.bold,
  highlight: chalk.white.bold,
  muted: chalk.hex('#888888'),
  pending: chalk.yellow,
  success: chalk.green,
  system: chalk.blue,
  user: chalk.green,
  warning: chalk.yellow.bold,
} as const;

export function disableColors(): void {
  chalk.level = 0;
}

export function initTheme(): void {
  if (process.env.NO_COLOR) {
    disableColors();
  }
}
