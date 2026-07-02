import { Box, Text } from 'ink';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, rolePrefix, spacing } from '../theme/chalkTheme.js';

const kindColor: Record<string, string> = {
  status: colors.info,
  tool_call: colors.pending,
  tool_result: colors.success,
};

const kindPrefix: Record<string, string> = {
  status: '●',
  tool_call: rolePrefix.tool,
  tool_result: rolePrefix.toolDone,
};

export const ActivityPanel: React.FC = () => {
  const events = useAppStore((state) => state.activity);
  const visible = events.slice(-8);

  if (visible.length === 0) {
    return null;
  }

  return (
    <Box
      borderColor={colors.borderSecondary}
      borderStyle="round"
      flexDirection="column"
      marginBottom={spacing.sectionMargin}
      paddingX={spacing.panelPadX}
    >
      <Box>
        <Text bold color={colors.borderSecondary}>
          Live Activity
        </Text>
      </Box>
      {visible.map((event) => (
        <Box key={event.id}>
          <Text color={kindColor[event.kind] ?? colors.muted}>
            {kindPrefix[event.kind] ?? '•'} {event.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
};
