/**
 * Centralized keybinding reference for the enterprise shell.
 *
 * The footer always shows a compact set for the current focus target;
 * the `?` overlay shows the full reference. Defining them in one place
 * keeps the help text in sync with the actual handlers wired in ShellScreen.
 */

export interface Keybind {
  desc: string;
  keys: string;
}

/** Keybinds shown in the footer while input is focused (default). */
export const primaryKeybinds: Keybind[] = [
  { desc: 'send', keys: 'Enter' },
  { desc: 'cycle focus', keys: 'Tab' },
  { desc: 'search', keys: '/' },
  { desc: 'help', keys: '?' },
  { desc: 'compact', keys: 'H' },
  { desc: 'history', keys: 'h' },
  { desc: 'quit', keys: ':q' },
];

/** Keybinds shown in the footer while output area is focused. */
export const outputKeybinds: Keybind[] = [
  { desc: 'history', keys: 'h' },
  { desc: 'compact', keys: 'H' },
  { desc: 'expand reasoning', keys: 'Ctrl+R' },
  { desc: 'search', keys: '/' },
  { desc: 'next panel', keys: 'Tab' },
  { desc: 'back', keys: 'Esc' },
];

/** Keybinds shown in the footer while filters panel is focused. */
export const filterKeybinds: Keybind[] = [
  { desc: 'navigate', keys: 'j/k' },
  { desc: 'toggle', keys: 'Space' },
  { desc: 'next panel', keys: 'Tab' },
  { desc: 'back', keys: 'Esc' },
];

/** Keybinds shown in the footer while search mode is active. */
export const searchKeybinds: Keybind[] = [
  { desc: 'scroll matches', keys: 'j/k' },
  { desc: 'clear', keys: 'Esc' },
];

/** Full reference for the `?` help overlay. */
export const helpKeybinds: Keybind[] = [
  { desc: 'Send message', keys: 'Enter' },
  { desc: 'Start search (live filter)', keys: '/' },
  { desc: 'Clear search / close overlay', keys: 'Esc' },
  { desc: 'Toggle live swarm panel', keys: 'P' },
  { desc: 'Toggle compact header', keys: 'H (shift+h)' },
  { desc: 'Expand/collapse reasoning block', keys: 'Ctrl+R' },
  { desc: 'Open session history', keys: 'h' },
  { desc: 'Cycle focus (input → output → filters)', keys: 'Tab' },
  { desc: 'Toggle filter (in filters panel)', keys: 'Space' },
  { desc: 'Dismiss toast notification', keys: 'x' },
  { desc: 'Toggle this help', keys: '?' },
  { desc: 'Slash commands', keys: '/help /clear /report' },
  { desc: 'Quit', keys: ':q or Ctrl+C' },
];
