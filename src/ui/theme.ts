/**
 * Shadow Auditor — Premium TUI Theme
 *
 * Compatibility re-export of the new Chalk-based theme system.
 * New code should import from `./theme/chalkTheme.js` directly.
 */

export {
  chalkTheme,
  colors,
  getPanelStyle,
  initTheme,
  labels,
  layout,
  type PanelStyle,
  rolePrefix,
  spacing,
} from './theme/chalkTheme.js';
