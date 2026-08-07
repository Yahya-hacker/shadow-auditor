import React, { useCallback, useRef, useState } from 'react';
/**
 * OptionList — reusable interactive selection list.
 *
 * Replaces Ink's `<SelectInput>` across dialogs and setup screens.
 * Keyboard navigation: j/ArrowDown to move down, k/ArrowUp to move up,
 * Enter to confirm selection, Esc to cancel (selects first option).
 */

import { Box, type KeyEvent, Text, useKeyHandler } from "../primitives.js";
import { colors } from '../theme/chalkTheme.js';

interface OptionListProps {
  /** Whether the list should respond to keyboard events */
  focused?: boolean;
  /** Controlled highlight index (external keyboard handling). Falls back to internal state if omitted. */
  highlightedIndex?: number;
  /** Called when the user presses Escape to cancel. If omitted, Escape is a no-op. */
  onCancel?: () => void;
  /** Called with the selected value on Enter */
  onSelect: (value: string) => void;
  /** The selectable options */
  options: Array<{ label: string; value: string }>;
  /** Optional single-key shortcuts mapped to option values. */
  shortcuts?: Readonly<Record<string, string>>;
}

export const OptionList: React.FC<OptionListProps> = ({
  focused = true,
  highlightedIndex,
  onCancel,
  onSelect,
  options,
  shortcuts,
}) => {
  const [internalHighlighted, setInternalHighlighted] = useState(0);
  const highlighted = highlightedIndex ?? internalHighlighted;

  // Stable refs so the key handler callback never changes due to prop identity.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKey = useCallback(
    (evt: KeyEvent) => {
      if (!focused) return;
      const opts = optionsRef.current;
      const shortcutValue = shortcutsRef.current?.[evt.key.toLowerCase()];
      if (shortcutValue !== undefined) {
        onSelectRef.current(shortcutValue);
        return;
      }

      switch (evt.key) {
        case 'ArrowDown':
        case 'j': {
          setInternalHighlighted((p) => Math.min(p + 1, opts.length - 1));
          break;
        }

        case 'ArrowUp':
        case 'k': {
          setInternalHighlighted((p) => Math.max(p - 1, 0));
          break;
        }

        case 'Enter': {
          onSelectRef.current(opts[highlighted]!.value);
          break;
        }

        case 'Escape': {
          onCancelRef.current?.();
          break;
        }
      }
    },
    [focused, highlighted],
  );

  // Only handle keys when uncontrolled; when a parent supplies
  // `highlightedIndex` (e.g. SetupScreen) it drives navigation itself.
  const controlled = highlightedIndex !== undefined;
  useKeyHandler(handleKey, focused && !controlled);

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const isHL = focused && i === highlighted;
        return (
          <Text
            bold={isHL}
            color={isHL ? colors.focusBorder : colors.muted}
            key={opt.value}
          >
            {isHL ? '❯ ' : '  '}
            {opt.label}
          </Text>
        );
      })}
    </Box>
  );
};
