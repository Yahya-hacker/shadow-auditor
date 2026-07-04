import { Text } from 'ink';
import React from 'react';

import { colors, type PanelStyle } from '../theme.js';

interface PanelTitleProps {
  /** Whether this panel is currently focused (affects styling). */
  focused?: boolean;
  /** Whether this is a light-themed panel (affects colors). */
  light?: boolean;
  /** Panel style override (border color + style). If omitted, computed from focused/light. */
  style?: PanelStyle;
  /** Title text displayed in the panel header. */
  title: string;
  /** Available inner width for padding the title. */
  width?: number;
}

/**
 * Reusable panel title component.
 *
 * Renders a single-line title bar with the title text, padded to fill the
 * panel width. Uses the panel's style (border color) for consistency.
 * Light panels use panelLightFg/panelLightBg colors; dark panels use brand.
 */
export const PanelTitle: React.FC<PanelTitleProps> = ({
  focused = false,
  light = false,
  style,
  title,
  width = 20,
}) => {
  const fg = light ? colors.panelLightFg : colors.brand;
  const bg = light ? colors.panelLightBg : undefined;
  const borderColor = style?.borderColor ?? (focused ? colors.focusBorder : colors.border);

  const paddedTitle = title.padEnd(width);

  return (
    <Text backgroundColor={bg} bold color={focused ? borderColor : fg}>
      {paddedTitle}
    </Text>
  );
};
