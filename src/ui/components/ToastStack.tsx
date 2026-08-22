import React, { memo, useEffect } from 'react';
/**
 * ToastStack — notification overlay for transient messages.
 *
 * Renders a stack of color-coded notifications. Each toast auto-dismisses
 * after its `duration` (default 5000ms). Press 'x' to dismiss the oldest
 * visible toast.
 */

import { Box, Text } from "../primitives.js";
import { type Toast, useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

const toastTypeConfig: Record<Toast['type'], { borderColor: string; prefix: string }> = {
  error: { borderColor: colors.error, prefix: '[ERROR]' },
  info: { borderColor: colors.info, prefix: '[INFO]' },
  success: { borderColor: colors.success, prefix: '[OK]' },
  warning: { borderColor: colors.warning, prefix: '[WARN]' },
};

const ToastItem: React.FC<{ onDismiss: (id: string) => void; toast: Toast }> = memo(
  ({ onDismiss, toast }) => {
    const config = toastTypeConfig[toast.type] ?? toastTypeConfig.info;

    useEffect(() => {
      const duration = toast.duration ?? 5000;
      if (duration <= 0) return;
      const timer = setTimeout(() => onDismiss(toast.id), duration);
      return () => clearTimeout(timer);
    }, [toast.id, toast.duration, onDismiss]);

    return (
      <Box
        borderColor={config.borderColor}
        borderStyle={'single'}
        marginBottom={0}
        paddingX={1}
      >
        <Text bold color={config.borderColor}>{config.prefix} </Text>
        <Text color={colors.bright}>{toast.message}</Text>
        <Text color={colors.dim}> [x]</Text>
      </Box>
    );
  },
);
ToastItem.displayName = 'ToastItem';

export const ToastStack: React.FC = memo(() => {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <Box flexDirection="column">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          onDismiss={dismissToast}
          toast={toast}
        />
      ))}
    </Box>
  );
});

ToastStack.displayName = 'ToastStack';
