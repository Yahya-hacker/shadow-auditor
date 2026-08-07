import React from 'react';
/**
 * HelpOverlay — full keybinding reference.
 *
 * Rendered in place of the output area when `helpOpen` is true.
 * `?` toggles it open, `Esc` closes.
 */

import { helpKeybinds } from '../keybinds.js';
import { Box, Text } from "../primitives.js";
import { colors, labels, spacing } from '../theme/chalkTheme.js';

export const HelpOverlay: React.FC = () => (
    <Box
      borderColor={colors.focusBorder} borderStyle={'double'}
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
