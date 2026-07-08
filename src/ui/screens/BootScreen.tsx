import { Box, Text, Input } from "../../opentui/components.js";
/**
 * BootScreen — onboarding banner with name entry.
 *
 * Interactive `<Input>` replaces ink-text-input.
 */

import React, { useCallback, useEffect, useState } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

const BANNER = `
   _____ __               __              ___                   __  __           __
  / ___// /_  ____ _____ / /      ____   /   |  __  __ ____/ // /_/ /_  _____/ /
  \\__ \\/ __ \\/ __ \`/ __ \\| | /| / __ \\ / /| | / / / // __  // __/ / / / ___/ _ \\
 ___/ / / / / /_/ / /_/ /| |/ |/ /_/ // ___ |/ /_/ // /_/ // /_/ /_/ / /  /  __/
/____/_/ /_/\\__,_/\\____/ |__/|__/\\____//_/  |_|\__,_/ \\__,_/ \\__/\\__,_/_/   \\___/
`;

interface BootScreenProps {
  onBootComplete?: () => void;
}

export const BootScreen: React.FC<BootScreenProps> = ({ onBootComplete }) => {
  const setScreen = useAppStore((s) => s.setScreen);
  const setUserName = useAppStore((s) => s.setUserName);
  const [phase, setPhase] = useState<'banner' | 'greeting' | 'name'>('banner');
  const [name, setName] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setPhase('name'), 5000);
    return () => clearTimeout(timer);
  }, []);

  const handleNameSubmit = (val: string) => {
    const trimmed = val.trim() || 'User';
    setUserName(trimmed);
    setName(trimmed);
    setPhase('greeting');
    setTimeout(() => {
      if (onBootComplete) {
        onBootComplete();
      } else {
        useAppStore.getState().setScreen('setup');
      }
    }, 2000);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={colors.brand}>{BANNER}</Text>

      {phase === 'banner' && (
        <Text color={colors.muted}>Initializing Shadow Auditor...</Text>
      )}

      {phase === 'name' && (
        <Box flexDirection="column">
          <Text color={colors.bright}>
            Can Shadow know what's your name or how to call you?
          </Text>
          <Input
            value={name}
            onChange={(v: string) => setName(v)}
            onSubmit={handleNameSubmit}
            placeholder="Enter your name..."
          />
        </Box>
      )}

      {phase === 'greeting' && (
        <Text color={colors.success} bold>
          Greetings, {name}. I am Shadow, your autonomous security companion.
        </Text>
      )}
    </Box>
  );
};
