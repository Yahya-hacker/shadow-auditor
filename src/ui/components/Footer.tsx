import { Box, Text } from 'ink';
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
    <Text bold color={colors.dim}>
      [{keys}]
    </Text>
    <Text color={colors.muted} dimColor> {desc} · </Text>
  </>
));

KeybindTag.displayName = 'KeybindTag';

/**
 * One-line contextual keybinding bar. Shows the keybind set appropriate for
 * the current focus target: input → primary, output → output, filters →
 * filter, search → search. Memoized to prevent re-rendering on every keystroke
 * when the parent InputArea re-renders from the `input` store subscription.
 */
export const Footer: React.FC = memo(() => {
  const focus = useAppStore((state) => state.focus);
  const searchActive = useAppStore((state) => state.searchActive);

  let keybinds: Keybind[];
  if (searchActive) {
    keybinds = searchKeybinds;
  } else {
    switch (focus) {
      case 'filters': { keybinds = filterKeybinds; break;
      }

      case 'output': { keybinds = outputKeybinds; break;
      }

      case 'panel': { keybinds = outputKeybinds; break;
      }

      default: { keybinds = primaryKeybinds; break;
      }
    }
  }

  return (
    <Box>
      {keybinds.map((kb) => (
        <React.Fragment key={`${kb.keys}-${kb.desc}`}>
          <KeybindTag desc={kb.desc} keys={kb.keys} />
        </React.Fragment>
      ))}
    </Box>
  );
});

Footer.displayName = 'Footer';
