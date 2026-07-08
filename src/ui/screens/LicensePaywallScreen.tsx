import { Box, Text, Input } from "../../opentui/components.js";
/**
 * LicensePaywallScreen — PRO feature gate.
 */

import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

export const LicensePaywallScreen: React.FC = () => {
  const gateResult = useAppStore((state) => state.licenseGate);

  if (!gateResult) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      padding={spacing.panelPadY}
      paddingX={spacing.panelPadX}
    >
      <Box
        borderColor={colors.warning} borderStyle={'rounded'}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text color={colors.warning} bold>
          ⚡ PRO FEATURE REQUIRED
        </Text>
        <Box marginTop={1}>
          <Text>
            The feature{' '}
            <Text color={colors.agent} bold>
              {gateResult.feature}
            </Text>{' '}
            requires a{' '}
            <Text color={colors.brand} bold>
              {gateResult.requiredTier?.toUpperCase()}
            </Text>{' '}
            license.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.muted}>
            Your current tier:{' '}
            <Text bold>
              {gateResult.currentTier?.toUpperCase() ?? 'FREE'}
            </Text>
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1} paddingX={spacing.inputPadX}>
        <Text color={colors.success} bold>
          🔑 Upgrade to unlock:
        </Text>
        <Text color={colors.muted}>  • Deep SAST analysis with full taint tracing</Text>
        <Text color={colors.muted}>  • Comprehensive PDF/Markdown security reports</Text>
        <Text color={colors.muted}>  • CI/CD integration with exit codes</Text>
        <Text color={colors.muted}>  • Priority support</Text>
      </Box>

      <Box marginTop={1} paddingX={spacing.inputPadX}>
        <Text>
          👉{' '}
          <Text color={colors.agent} bold underline>
            {gateResult.upgradeUrl}
          </Text>
        </Text>
      </Box>

      <Box marginTop={1} paddingX={spacing.inputPadX}>
        <Text color={colors.dim}>
          Already purchased? Run{' '}
          <Text bold>shadow-auditor --reconfigure</Text>{' '}
          to enter your license key.
        </Text>
      </Box>
    </Box>
  );
};
