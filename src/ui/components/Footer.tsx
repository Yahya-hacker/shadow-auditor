import { Box, Text } from 'ink';
import React from 'react';

import { type Keybind, primaryKeybinds, searchKeybinds } from '../keybinds.js';
import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

const KeybindTag: React.FC<Keybind> = ({ desc, keys }) => (
  <>
    <Text bold color={colors.brand}>
      [{keys}]
    </Text>
    <Text color={colors.muted}> {desc} </Text>
  </>
);

/**
 * One-line contextual keybinding bar. Shows the primary keybinds by default and
 * a search-mode set while a search is active. Replaces the legacy hardcoded
 * hint that lived in InputArea.
 */
export const Footer: React.FC = () => {
  const searchActive = useAppStore((state) => state.searchActive);
  const keybinds = searchActive ? searchKeybinds : primaryKeybinds;

  return (
    <Box>
      {keybinds.map((kb) => (
        <React.Fragment key={`${kb.keys}-${kb.desc}`}>
          <KeybindTag desc={kb.desc} keys={kb.keys} />
        </React.Fragment>
      ))}
    </Box>
  );
};
