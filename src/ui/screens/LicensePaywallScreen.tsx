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
    <box
      flexDirection="column"
      padding={spacing.panelPadY}
      paddingX={spacing.panelPadX}
    >
      <box
        border={{ color: colors.warning, style: 'round' }}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <text style={{ color: colors.warning, fontWeight: 'bold' }}>
          ⚡ PRO FEATURE REQUIRED
        </text>
        <box marginTop={1}>
          <text>
            The feature{' '}
            <text style={{ color: colors.agent, fontWeight: 'bold' }}>
              {gateResult.feature}
            </text>{' '}
            requires a{' '}
            <text style={{ color: colors.brand, fontWeight: 'bold' }}>
              {gateResult.requiredTier?.toUpperCase()}
            </text>{' '}
            license.
          </text>
        </box>
        <box marginTop={1}>
          <text style={{ color: colors.muted }}>
            Your current tier:{' '}
            <text style={{ fontWeight: 'bold' }}>
              {gateResult.currentTier?.toUpperCase() ?? 'FREE'}
            </text>
          </text>
        </box>
      </box>

      <box flexDirection="column" marginTop={1} paddingX={spacing.inputPadX}>
        <text style={{ color: colors.success, fontWeight: 'bold' }}>
          🔑 Upgrade to unlock:
        </text>
        <text style={{ color: colors.muted }}>  • Deep SAST analysis with full taint tracing</text>
        <text style={{ color: colors.muted }}>  • Comprehensive PDF/Markdown security reports</text>
        <text style={{ color: colors.muted }}>  • CI/CD integration with exit codes</text>
        <text style={{ color: colors.muted }}>  • Priority support</text>
      </box>

      <box marginTop={1} paddingX={spacing.inputPadX}>
        <text>
          👉{' '}
          <text style={{ color: colors.agent, fontWeight: 'bold', textDecoration: 'underline' }}>
            {gateResult.upgradeUrl}
          </text>
        </text>
      </box>

      <box marginTop={1} paddingX={spacing.inputPadX}>
        <text style={{ color: colors.dim }}>
          Already purchased? Run{' '}
          <text style={{ fontWeight: 'bold' }}>shadow-auditor --reconfigure</text>{' '}
          to enter your license key.
        </text>
      </box>
    </box>
  );
};
