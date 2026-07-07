/**
 * TargetSelectionScreen — choose audit target directory.
 *
 * `<input>` replaces ink-text-input for path entry.
 */

import React, { useCallback, useState } from 'react';

import { startRepoMapGeneration } from '../hooks/useAgentSession.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels, spacing } from '../theme/chalkTheme.js';

export const TargetSelectionScreen: React.FC = () => {
  const [showCustom, setShowCustom] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [error, setError] = useState('');
  const setScreen = useAppStore((state) => state.setScreen);
  const setSessionTarget = useAppStore((state) => state.setSessionTarget);

  const proceed = (target: string) => {
    startRepoMapGeneration(target);
    setSessionTarget(target);
    setScreen('initializing');
  };

  const handleDefaultSubmit = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'n' || normalized === 'no') {
      setShowCustom(true);
      setCustomPath('');
      setError('');
      return;
    }
    proceed(process.cwd());
  };

  const handleCustomSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Please enter a path.');
      return;
    }
    proceed(trimmed);
  };

  return (
    <box flexDirection="column" paddingX={spacing.panelPadX}>
      <box
        border={{ color: colors.brand, style: 'round' }}
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>
          ◈ {labels.appName} — Target Selection
        </text>
      </box>

      <box flexDirection="column" marginTop={1}>
        {showCustom ? (
          <box flexDirection="column">
            <box>
              <text style={{ color: colors.pending }}>Enter target directory: </text>
              <input
                value={customPath}
                onChange={(v: string) => setCustomPath(v)}
                onSubmit={handleCustomSubmit}
                placeholder="/path/to/project"
              />
            </box>
            {error && (
              <box marginTop={1}>
                <text style={{ color: colors.error }}>✖ {error}</text>
              </box>
            )}
          </box>
        ) : (
          <box>
            <text style={{ color: colors.pending }}>
              Use current directory (
            </text>
            <text style={{ color: colors.bright, fontWeight: 'bold' }}>
              {process.cwd()}
            </text>
            <text style={{ color: colors.pending }}>
              ) for the audit? [Y/n]{' '}
            </text>
            <input
              value={customPath}
              onChange={(v: string) => setCustomPath(v)}
              onSubmit={handleDefaultSubmit}
            />
          </box>
        )}
      </box>
    </box>
  );
};
