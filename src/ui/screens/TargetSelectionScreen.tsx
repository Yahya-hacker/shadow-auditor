import React, { useState } from 'react';
/**
 * TargetSelectionScreen — choose audit target directory.
 *
 * `<Input>` replaces ink-text-input for path entry.
 */

import {
  type AuditTargetIdentity,
  isSameAuditTarget,
  resolveAuditTarget,
} from '../../utils/audit-target.js';
import { OptionList } from '../components/OptionList.js';
import { startRepoMapGeneration } from '../hooks/useAgentSession.js';
import { Box, Input, Text } from "../primitives.js";
import { requestShutdown } from '../shutdown.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels, spacing } from '../theme/chalkTheme.js';

const trustOptions = [
  {label: 'Yes, audit this target', value: 'yes'},
  {label: 'No, exit without reading it', value: 'no'},
];

export const TargetSelectionScreen: React.FC<{initialTarget?: string}> = ({initialTarget}) => {
  const [initialSelection] = useState(() => {
    if (!initialTarget) return {};
    try {
      return {target: resolveAuditTarget(initialTarget)};
    } catch (error) {
      return {error: error instanceof Error ? error.message : 'The target directory is not readable.'};
    }
  });
  const sessionError = useAppStore((state) => state.session.error);
  const [showCustom, setShowCustom] = useState(Boolean(initialTarget && !initialSelection.target));
  const [customPath, setCustomPath] = useState('');
  const [error, setError] = useState(initialSelection.error ?? sessionError ?? '');
  const [pendingTarget, setPendingTarget] = useState<AuditTargetIdentity | null>(
    initialSelection.target ?? null,
  );
  const setScreen = useAppStore((state) => state.setScreen);
  const setSessionError = useAppStore((state) => state.setSessionError);
  const setSessionTarget = useAppStore((state) => state.setSessionTarget);

  const selectTarget = (target: string): boolean => {
    try {
      setPendingTarget(resolveAuditTarget(target));
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : 'The target directory is not readable.');
      return false;
    }

    setError('');
    return true;
  };

  const handleTrustSelect = (value: string) => {
    if (value !== 'yes' || !pendingTarget) {
      requestShutdown().catch(() => {
        process.exitCode = 1;
      });
      return;
    }

    let currentTarget: AuditTargetIdentity;
    try {
      currentTarget = resolveAuditTarget(pendingTarget.canonicalPath);
    } catch (error_) {
      setPendingTarget(null);
      setError(error_ instanceof Error ? error_.message : 'The target directory is no longer readable.');
      return;
    }

    if (!isSameAuditTarget(pendingTarget, currentTarget)) {
      setPendingTarget(currentTarget);
      setError('The target changed before approval. Review the resolved directory and approve it again.');
      return;
    }

    startRepoMapGeneration(currentTarget);
    setSessionError(null);
    setSessionTarget(currentTarget.canonicalPath, currentTarget);
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

    if (normalized !== '' && normalized !== 'y' && normalized !== 'yes') {
      setError('Enter Y/Yes or N/No.');
      return;
    }

    selectTarget(process.cwd());
  };

  const handleCustomSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Please enter a path.');
      return;
    }

    selectTarget(trimmed);
  };

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.brand} borderStyle={'rounded'}
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text bold color={colors.brand}>
          ◈ {labels.appName} — Target Selection
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {pendingTarget ? (
          <Box flexDirection="column">
            <Text color={colors.bright}>Shadow Auditor will deeply read this target:</Text>
            <Text bold color={colors.pending}>{pendingTarget.canonicalPath}</Text>
            <Box marginBottom={1} marginTop={1}>
              <Text color={colors.muted}>Do you trust this directory and its contents?</Text>
            </Box>
            {error && (
              <Box marginBottom={1}>
                <Text color={colors.error}>✖ {error}</Text>
              </Box>
            )}
            <OptionList
              onCancel={() => handleTrustSelect('no')}
              onSelect={handleTrustSelect}
              options={trustOptions}
              shortcuts={{n: 'no', y: 'yes'}}
            />
          </Box>
        ) : showCustom ? (
          <Box flexDirection="column">
            <Box>
              <Text color={colors.pending}>Enter target directory: </Text>
              <Input
                onChange={(v: string) => setCustomPath(v)}
                onSubmit={handleCustomSubmit}
                placeholder="/path/to/project"
                value={customPath}
              />
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={colors.error}>✖ {error}</Text>
              </Box>
            )}
          </Box>
        ) : (
          <Box>
            <Text color={colors.pending}>
              Use current directory (
            </Text>
            <Text bold color={colors.bright}>
              {process.cwd()}
            </Text>
            <Text color={colors.pending}>
              ) for the audit? [Y/n]{' '}
            </Text>
            <Input
              onChange={(v: string) => setCustomPath(v)}
              onSubmit={handleDefaultSubmit}
              value={customPath}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};
