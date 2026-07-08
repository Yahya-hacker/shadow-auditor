import { Box, Text, Input } from "../../opentui/components.js";
/**
 * OptionList — reusable interactive selection list.
 *
 * Replaces Ink's `<SelectInput>` across dialogs and setup screens.
 * Keyboard navigation: j/ArrowDown to move down, k/ArrowUp to move up,
 * Enter to confirm selection, Esc to cancel (selects first option).
 */

import React, { useCallback, useRef, useState } from 'react';

import { colors } from '../theme/chalkTheme.js';

interface OptionListProps {
  /** The selectable options */
  options: Array<{ label: string; value: string }>;
  /** Called with the selected value on Enter */
  onSelect: (value: string) => void;
  /** Called when the user presses Escape to cancel. If omitted, Escape is a no-op. */
  onCancel?: () => void;
  /** Whether the list should respond to keyboard events */
  focused?: boolean;
}

export const OptionList: React.FC<OptionListProps> = ({
  options,
  onSelect,
  onCancel,
  focused = true,
}) => {
  const [highlighted, setHighlighted] = useState(0);

  // Stable refs so the key handler callback never changes due to prop identity.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const handleKey = useCallback(
    (evt: React.KeyboardEvent) => {
      if (!focused) return;
      const opts = optionsRef.current;
      switch (evt.key) {
        case 'ArrowDown':
        case 'j':
          setHighlighted((p) => Math.min(p + 1, opts.length - 1));
          break;
        case 'ArrowUp':
        case 'k':
          setHighlighted((p) => Math.max(p - 1, 0));
          break;
        case 'Enter':
          onSelectRef.current(opts[highlighted]!.value);
          break;
        case 'Escape':
          onCancelRef.current?.();
          break;
      }
    },
    [focused, highlighted],
  );

  return (
    <Box flexDirection="column" onKeyDown={handleKey}>
      {options.map((opt, i) => {
        const isHL = focused && i === highlighted;
        return (
          <Text
            key={opt.value}
            color={isHL ? colors.focusBorder : colors.muted}
            bold={isHL}
          >
            {isHL ? '❯ ' : '  '}
            {opt.label}
          </Text>
        );
      })}
    </Box>
  );
};
