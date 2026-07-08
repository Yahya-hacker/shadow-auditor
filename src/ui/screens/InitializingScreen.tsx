import { Box, Text, Input } from "../../opentui/components.js";
/**
 * InitializingScreen — loading state while the security engine spins up.
 *
 * `<Text animate="pulse">●</Text>` replaces Ink's `<Spinner type="dots">`.
 */

import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

export const InitializingScreen: React.FC = () => {
  const targetPath = useAppStore((state) => state.session.targetPath);

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.agent} borderStyle={'rounded'}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text color={colors.brand} bold>
          ◈ Initializing Security Engine
        </Text>
        <Box marginTop={1}>
          <Text color={colors.agent} animate="pulse">●</Text>
          <Text color={colors.muted}> Parsing AST with tree-sitter</Text>
        </Box>
        <Box>
          <Text color={colors.agent} animate="pulse">●</Text>
          <Text color={colors.muted}> Building semantic index & embeddings</Text>
        </Box>
        <Box>
          <Text color={colors.agent} animate="pulse">●</Text>
          <Text color={colors.muted}> Loading knowledge graph</Text>
        </Box>
        <Box>
          <Text color={colors.agent} animate="pulse">●</Text>
          <Text color={colors.muted}> Configuring multi-agent workflow</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.dim}>Target: {targetPath}</Text>
        </Box>
      </Box>
    </Box>
  );
};
