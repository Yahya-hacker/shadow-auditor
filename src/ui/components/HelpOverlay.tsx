/**
 * HelpOverlay — full keybinding reference.
 *
 * Rendered in place of the output area when `helpOpen` is true.
 * `?` toggles it open, `Esc` closes.
 */

import React from 'react';

import { helpKeybinds } from '../keybinds.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels, spacing } from '../theme/chalkTheme.js';

export const HelpOverlay: React.FC = () => {
  const helpOpen = useAppStore((state) => state.helpOpen);
  if (!helpOpen) return null;

  return (
    <box
      border={{ color: colors.focusBorder, style: 'double' }}
      flexDirection="column"
      flexGrow={1}
      paddingX={spacing.panelPadX}
      paddingY={spacing.panelPadY}
    >
      <text style={{ color: colors.brand, fontWeight: 'bold' }}>
        {labels.appName} — Keybindings
      </text>
      {helpKeybinds.map((kb) => (
        <box gap={2} key={`${kb.keys}-${kb.desc}`}>
          <text style={{ color: colors.bright, fontWeight: 'bold' }}>
            {kb.keys.padEnd(32)}
          </text>
          <text style={{ color: colors.muted }}>{kb.desc}</text>
        </box>
      ))}
      <text style={{ color: colors.dim }}>Press ? or Esc to close.</text>
    </box>
  );
};
