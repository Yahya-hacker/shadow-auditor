/**
 * BootScreen — onboarding banner with name entry.
 *
 * Interactive `<input>` replaces ink-text-input.
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
    <box flexDirection="column" padding={1}>
      <text style={{ color: colors.brand }}>{BANNER}</text>

      {phase === 'banner' && (
        <text style={{ color: colors.muted }}>Initializing Shadow Auditor...</text>
      )}

      {phase === 'name' && (
        <box flexDirection="column">
          <text style={{ color: colors.bright }}>
            Can Shadow know what's your name or how to call you?
          </text>
          <input
            value={name}
            onChange={(v: string) => setName(v)}
            onSubmit={handleNameSubmit}
            placeholder="Enter your name..."
          />
        </box>
      )}

      {phase === 'greeting' && (
        <text style={{ color: colors.success, fontWeight: 'bold' }}>
          Greetings, {name}. I am Shadow, your autonomous security companion.
        </text>
      )}
    </box>
  );
};
