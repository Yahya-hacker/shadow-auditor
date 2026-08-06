import React, { useEffect, useRef, useState } from 'react';
/**
 * BootScreen — onboarding banner with name entry.
 *
 * Interactive `<Input>` replaces ink-text-input.
 */

import { Box, Input, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

/* eslint-disable no-useless-escape */
const BANNER = `
   _____ __               __              ___                   __  __           __
  / ___// /_  ____ _____ / /      ____   /   |  __  __ ____/ // /_/ /_  _____/ /
  \\__ \\/ __ \\/ __ \`/ __ \\| | /| / __ \\ / /| | / / / // __  // __/ / / / ___/ _ \\
 ___/ / / / / /_/ / /_/ /| |/ |/ /_/ // ___ |/ /_/ // /_/ // /_/ /_/ / /  /  __/
/____/_/ /_/\\__,_/\\____/ |__/|__/\\____//_/  |_|\__,_/ \\__,_/ \\__/\\__,_/_/   \\___/
`;
/* eslint-enable no-useless-escape */

interface BootScreenProps {
  onBootComplete?: () => void;
}

export const BootScreen: React.FC<BootScreenProps> = ({ onBootComplete }) => {
  const setScreen = useAppStore((s) => s.setScreen);
  const setUserName = useAppStore((s) => s.setUserName);
  const [phase, setPhase] = useState<'banner' | 'greeting' | 'name'>('banner');
  const [name, setName] = useState('');
  const mountedRef = useRef(true);
  const greetingTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    mountedRef.current = true;
    const timer = setTimeout(() => {
      if (mountedRef.current) setPhase('name');
    }, 5000);
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      if (greetingTimerRef.current) clearTimeout(greetingTimerRef.current);
    };
  }, []);

  const handleNameSubmit = (val: string) => {
    const trimmed = val.trim() || 'User';
    setUserName(trimmed);
    setName(trimmed);
    setPhase('greeting');
    greetingTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (onBootComplete) {
        onBootComplete();
      } else {
        setScreen('setup');
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
            onChange={(v: string) => setName(v)}
            onSubmit={handleNameSubmit}
            placeholder="Enter your name..."
            value={name}
          />
        </Box>
      )}

      {phase === 'greeting' && (
        <Text bold color={colors.success}>
          Greetings, {name}. I am Shadow, your autonomous security companion.
        </Text>
      )}
    </Box>
  );
};
