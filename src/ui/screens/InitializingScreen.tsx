/**
 * InitializingScreen — loading state while the security engine spins up.
 *
 * `<text animate="pulse">●</text>` replaces Ink's `<Spinner type="dots">`.
 */

import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

export const InitializingScreen: React.FC = () => {
  const targetPath = useAppStore((state) => state.session.targetPath);

  return (
    <box flexDirection="column" paddingX={spacing.panelPadX}>
      <box
        border={{ color: colors.agent, style: 'round' }}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>
          ◈ Initializing Security Engine
        </text>
        <box marginTop={1}>
          <text style={{ color: colors.agent }} animate="pulse">●</text>
          <text style={{ color: colors.muted }}> Parsing AST with tree-sitter</text>
        </box>
        <box>
          <text style={{ color: colors.agent }} animate="pulse">●</text>
          <text style={{ color: colors.muted }}> Building semantic index & embeddings</text>
        </box>
        <box>
          <text style={{ color: colors.agent }} animate="pulse">●</text>
          <text style={{ color: colors.muted }}> Loading knowledge graph</text>
        </box>
        <box>
          <text style={{ color: colors.agent }} animate="pulse">●</text>
          <text style={{ color: colors.muted }}> Configuring multi-agent workflow</text>
        </box>
        <box marginTop={1}>
          <text style={{ color: colors.dim }}>Target: {targetPath}</text>
        </box>
      </box>
    </box>
  );
};
