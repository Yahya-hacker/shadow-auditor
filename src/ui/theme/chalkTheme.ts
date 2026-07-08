import chalk from 'chalk';

/**
 * Shadow Auditor — Enterprise TUI Theme.
 *
 * Design follows the TUI design system: color encodes meaning (not
 * decoration), and the interface degrades gracefully across terminal color
 * tiers. Every semantic slot is a truecolor hex value; the terminal and chalk
 * downsample it to the terminal's capability based on `chalk.level` (set in
 * {@link initTheme}). A dark palette ships by default with a light variant.
 *
 * Accessibility: `NO_COLOR` disables all color; symbols, typography, and
 * layout carry the hierarchy independently, so the UI remains usable in
 * monochrome.
 */

export type ColorTier = 0 | 1 | 2 | 3; // 0=none, 1=16 ANSI, 2=256, 3=truecolor
export type ThemeMode = 'dark' | 'light';

/**
 * Semantic color slots. Components reference these indirectly via the
 * `colors` object (which maps legacy UI keys to these slots), so palettes can
 * be swapped without touching component code.
 */
export interface ThemePalette {
  accentPrimary: string;
  accentSecondary: string;
  borderBase: string;
  fgDefault: string;
  fgDim: string;
  fgEmphasis: string;
  fgMuted: string;
  statusError: string;
  statusInfo: string;
  statusSuccess: string;
  statusWarning: string;
}

const DARK_PALETTE: ThemePalette = {
  accentPrimary: '#7aa2f7',
  accentSecondary: '#bb9af7',
  borderBase: '#565f89',
  fgDefault: '#c0caf5',
  fgDim: '#414868',
  fgEmphasis: '#e0e0e0',
  fgMuted: '#565f89',
  statusError: '#f7768e',
  statusInfo: '#7dcfff',
  statusSuccess: '#9ece6a',
  statusWarning: '#e0af68',
};

const LIGHT_PALETTE: ThemePalette = {
  accentPrimary: '#0969da',
  accentSecondary: '#8250df',
  borderBase: '#afb8c1',
  fgDefault: '#24292f',
  fgDim: '#8c959f',
  fgEmphasis: '#1f2328',
  fgMuted: '#636c76',
  statusError: '#cf222e',
  statusInfo: '#0969da',
  statusSuccess: '#1a7f37',
  statusWarning: '#9a6700',
};

/**
 * Detect the terminal's color tier from the environment.
 *
 * Order: `NO_COLOR` → none; `COLORTERM` truecolor/24bit → truecolor;
 * `TERM` containing `256color` → 256; otherwise 16 ANSI.
 */
export function detectColorTier(): ColorTier {
  if (process.env.NO_COLOR) return 0;
  const colorterm = process.env.COLORTERM ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  const term = process.env.TERM ?? '';
  if (term.includes('256color')) return 2;
  return 1;
}

/**
 * Detect dark vs light terminal background.
 *
 * `COLORFGBG` is "fg:bg" (set by some terminals); a background value < 7
 * indicates a dark background. The `SHADOW_THEME` env var overrides this for
 * manual control/testing. Defaults to dark.
 */
export function detectThemeMode(): ThemeMode {
  const override = process.env.SHADOW_THEME?.toLowerCase();
  if (override === 'light' || override === 'dark') return override;
  const colorfgbg = process.env.COLORFGBG ?? '';
  if (colorfgbg) {
    const bg = Number(colorfgbg.split(':')[1]);
    if (!Number.isNaN(bg)) return bg < 7 ? 'dark' : 'light';
  }

  return 'dark';
}

export const colorTier: ColorTier = detectColorTier();
export const themeMode: ThemeMode = detectThemeMode();

const activePalette: ThemePalette = themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;

/**
 * OpenTUI-compatible color values (hex strings) mapped to the legacy UI key names
 * the components already import. Tier downsampling happens at render via
 * `chalk.level`.
 */
export const colors = {
  agent: activePalette.statusInfo,
  border: activePalette.borderBase,
  borderError: activePalette.statusError,
  borderSecondary: activePalette.accentSecondary,
  borderWarning: activePalette.statusWarning,
  brand: activePalette.accentPrimary,
  bright: activePalette.fgEmphasis,
  dim: activePalette.fgDim,
  error: activePalette.statusError,
  focusBorder: '#3b82f6',
  info: activePalette.statusInfo,
  muted: activePalette.fgMuted,
  panelDarkFg: '#f8fafc',
  panelLightBg: '#e2e8f0',
  panelLightFg: '#0f172a',
  pending: activePalette.statusWarning,
  success: activePalette.statusSuccess,
  system: activePalette.accentPrimary,
  user: activePalette.statusSuccess,
  warning: activePalette.statusWarning,
} as const;

export const labels = {
  appName: 'ShadowAuditor',
  appTagline: 'AI-Native SAST Platform',
  shellTitle: 'Interactive Security Analysis Shell',
  version: 'v1.2.0',
} as const;

export const layout = {
  COMPACT_THRESHOLD: 80,
  FOOTER_HEIGHT: 1,   // single-line status bar at the very bottom
  HEADER_HEIGHT: 4,   // 2 content lines + 2 border lines (double border)
  INPUT_HEIGHT: 4,    // border + content + border + footer line
  MIN_SIDEBAR_WIDTH: 18,
  SIDEBAR_RATIO: 0.25,
  STATUS_HEIGHT: 1,   // single-line status bar above input
} as const;

export type BorderStyleIdle = 'single';
export type BorderStyleFocused = 'double';

export interface PanelStyle {
  borderColor: string;
  borderStyle: BorderStyleFocused | BorderStyleIdle;
}

/**
 * Get the appropriate border styling for a panel based on focus and theme.
 * Idle panels use sharp corners (┌─┐), focused panels use heavy corners (╔═╗).
 */
export function getPanelStyle(isFocused: boolean, _isLight = false): PanelStyle {
  return {
    borderColor: isFocused ? colors.focusBorder : colors.border,
    borderStyle: isFocused ? 'double' : 'single',
  };
}

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

/**
 * Raw chalk helpers bound to the active palette. Used for stderr/logs output.
 * UI components should use the `colors` object instead.
 */
export const chalkTheme = {
  agent: chalk.hex(activePalette.statusInfo),
  brand: chalk.hex(activePalette.accentPrimary).bold,
  dim: chalk.hex(activePalette.fgDim),
  error: chalk.hex(activePalette.statusError),
  errorBold: chalk.hex(activePalette.statusError).bold,
  highlight: chalk.hex(activePalette.fgEmphasis).bold,
  muted: chalk.hex(activePalette.fgMuted),
  pending: chalk.hex(activePalette.statusWarning),
  success: chalk.hex(activePalette.statusSuccess),
  system: chalk.hex(activePalette.accentPrimary),
  user: chalk.hex(activePalette.statusSuccess),
  warning: chalk.hex(activePalette.statusWarning).bold,
} as const;

export function disableColors(): void {
  chalk.level = 0;
}

/**
 * Apply the detected color tier to the shared chalk singleton. Ink imports the
 * same chalk instance, so this governs `<Text color>` and border downsampling.
 * Respects `NO_COLOR`. Self-invoked at module load so callers need not
 * remember to call it.
 */
export function initTheme(): void {
  if (process.env.NO_COLOR) {
    disableColors();
    return;
  }

  chalk.level = colorTier;
}

initTheme();
