/**
 * Footer — contextual keybinding bar.
 *
 * Shows keybinds appropriate for the current focus target.
 * Memoized to prevent re-rendering on every keystroke.
 */

import React, { memo } from 'react';

import {
  filterKeybinds,
  type Keybind,
  outputKeybinds,
  primaryKeybinds,
  searchKeybinds,
} from '../keybinds.js';
import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

const KeybindTag: React.FC<Keybind> = memo(({ desc, keys }) => (
  <>
    <text style={{ color: colors.dim, fontWeight: 'bold' }}>[{keys}]</text>
    <text style={{ color: colors.muted, fontStyle: 'italic' }}> {desc} · </text>
  </>
));
KeybindTag.displayName = 'KeybindTag';

export const Footer: React.FC = memo(() => {
  const focus = useAppStore((state) => state.focus);
  const searchActive = useAppStore((state) => state.searchActive);

  let keybinds: Keybind[];
  if (searchActive) {
    keybinds = searchKeybinds;
  } else {
    switch (focus) {
      case 'filters': keybinds = filterKeybinds; break;
      case 'output': keybinds = outputKeybinds; break;
      case 'panel': keybinds = outputKeybinds; break;
      default: keybinds = primaryKeybinds; break;
    }
  }

  return (
    <box>
      {keybinds.map((kb) => (
        <React.Fragment key={`${kb.keys}-${kb.desc}`}>
          <KeybindTag desc={kb.desc} keys={kb.keys} />
        </React.Fragment>
      ))}
    </box>
  );
});

Footer.displayName = 'Footer';
