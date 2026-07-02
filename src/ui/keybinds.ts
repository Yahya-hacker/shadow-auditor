/**
 * Centralized keybinding reference for the enterprise shell.
 *
 * The footer always shows a compact primary set (L0/L1); the `?` overlay shows
 * the full reference (L2/L3). Defining them in one place keeps the help text in
 * sync with the actual handlers wired in ShellScreen.
 */

export interface Keybind {
  desc: string;
  keys: string;
}

/** Always-visible primary keybinds (footer). */
export const primaryKeybinds: Keybind[] = [
  { desc: 'send', keys: 'Enter' },
  { desc: 'scroll', keys: '↑↓/jk' },
  { desc: 'search', keys: '/' },
  { desc: 'help', keys: '?' },
  { desc: 'panel', keys: 'P' },
  { desc: 'focus', keys: 'Tab' },
  { desc: 'quit', keys: ':q' },
];

/** Keybinds shown in the footer while search mode is active. */
export const searchKeybinds: Keybind[] = [
  { desc: 'scroll matches', keys: 'j/k' },
  { desc: 'clear', keys: 'Esc' },
];

/** Full reference for the `?` help overlay. */
export const helpKeybinds: Keybind[] = [
  { desc: 'Send message', keys: 'Enter' },
  { desc: 'Scroll chat up / down', keys: '↑↓ or k / j' },
  { desc: 'Jump to top / bottom', keys: 'g / G' },
  { desc: 'Start search (live filter)', keys: '/' },
  { desc: 'Scroll within filtered matches', keys: 'k / j' },
  { desc: 'Clear search / close overlay', keys: 'Esc' },
  { desc: 'Toggle live swarm panel', keys: 'P' },
  { desc: 'Cycle focus (input ↔ panel)', keys: 'Tab' },
  { desc: 'Toggle this help', keys: '?' },
  { desc: 'Quit', keys: ':q or Ctrl+C' },
];
