import { Box, Text } from 'ink';
import React from 'react';

import { helpKeybinds } from '../keybinds.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels, spacing } from '../theme/chalkTheme.js';

/**
 * Full keybinding reference overlay. Rendered in place of the output area
 * when `helpOpen` is true (a modal focus-trap): `?` toggles it open, `Esc`
 * closes. Uses double borders + focusBorder color to match the spec's
 * focused aesthetic.
 */
export const HelpOverlay: React.FC = () => {
  const helpOpen = useAppStore((state) => state.helpOpen);
  if (!helpOpen) return null;

  return (
    <Box
      borderColor={colors.focusBorder}
      borderStyle="double"
      flexDirection="column"
      flexGrow={1}
      paddingX={spacing.panelPadX}
      paddingY={spacing.panelPadY}
    >
      <Text bold color={colors.brand}>
        {labels.appName} — Keybindings
      </Text>
      {helpKeybinds.map((kb) => (
        <Box gap={2} key={`${kb.keys}-${kb.desc}`}>
          <Text bold color={colors.bright}>
            {kb.keys.padEnd(32)}
          </Text>
          <Text color={colors.muted}>{kb.desc}</Text>
        </Box>
      ))}
      <Text color={colors.dim}>Press ? or Esc to close.</Text>
    </Box>
  );
};
