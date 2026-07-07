/**
 * OptionList — reusable interactive selection list.
 *
 * Replaces Ink's `<SelectInput>` across dialogs and setup screens.
 * Keyboard navigation: j/ArrowDown to move down, k/ArrowUp to move up,
 * Enter to confirm selection, Esc to cancel (selects first option).
 */

import React, { useCallback, useState } from 'react';

import { colors } from '../theme/chalkTheme.js';

interface OptionListProps {
  /** The selectable options */
  options: Array<{ label: string; value: string }>;
  /** Called with the selected value on Enter or Esc */
  onSelect: (value: string) => void;
  /** Whether the list should respond to keyboard events */
  focused?: boolean;
}

export const OptionList: React.FC<OptionListProps> = ({
  options,
  onSelect,
  focused = true,
}) => {
  const [highlighted, setHighlighted] = useState(0);

  const handleKey = useCallback(
    (evt: React.KeyboardEvent) => {
      if (!focused) return;
      switch (evt.key) {
        case 'ArrowDown':
        case 'j':
          setHighlighted((p) => Math.min(p + 1, options.length - 1));
          break;
        case 'ArrowUp':
        case 'k':
          setHighlighted((p) => Math.max(p - 1, 0));
          break;
        case 'Enter':
          onSelect(options[highlighted]!.value);
          break;
        case 'Escape':
          // Cancel: select the first option (typically the "safe" default)
          onSelect(options[0]!.value);
          break;
      }
    },
    [focused, highlighted, options, onSelect],
  );

  return (
    <box flexDirection="column" onKeyDown={handleKey}>
      {options.map((opt, i) => {
        const isHL = focused && i === highlighted;
        return (
          <text
            key={opt.value}
            style={{
              color: isHL ? colors.focusBorder : colors.muted,
              fontWeight: isHL ? 'bold' : 'normal',
            }}
          >
            {isHL ? '❯ ' : '  '}
            {opt.label}
          </text>
        );
      })}
    </box>
  );
};
