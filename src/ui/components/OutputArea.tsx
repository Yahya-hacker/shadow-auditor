import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { memo, useMemo } from 'react';

import { type ChatMessageData } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle } from '../theme.js';

interface OutputAreaProps {
  compact?: boolean;
}

/**
 * Main output area. Separates stable message history from dynamic
 * streaming content to minimize Ink re-renders.
 *
 * ┌─ Output (Logs & Responses) ─────────────────────────────────────┐
 * │ █  System initialized. Awaiting commands...                     │
 * └─────────────────────────────────────────────────────────────────┘
 */
export const OutputArea: React.FC<OutputAreaProps> = memo(({ compact = false }) => {
  const messages = useAppStore((s) => s.messages);
  const searchActive = useAppStore((s) => s.searchActive);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const isStreaming = useAppStore((s) => s.streaming);
  const streamingText = useAppStore((s) => s.streamingText);
  const activity = useAppStore((s) => s.activity);
  const focus = useAppStore((s) => s.focus);
  const filters = useAppStore((s) => s.filters);

  const isFocused = focus === 'output';
  const panelStyle = getPanelStyle(isFocused);

  // ── Filter messages ──────────────────────────────────────────────
  const visibleMessages = useMemo(() => {
    const query = searchActive && searchQuery ? searchQuery.toLowerCase() : '';
    if (query) {
      return messages.filter((m) => m.text.toLowerCase().includes(query));
    }
    return applyFilters(messages, filters);
  }, [messages, searchActive, searchQuery, filters]);

  // Last few activity events
  const recentActivity = useMemo(() => activity.slice(-3), [activity]);

  const hasContent = visibleMessages.length > 0 || isStreaming || recentActivity.length > 0;

  return (
    <Box
      borderColor={panelStyle.borderColor}
      borderStyle={panelStyle.borderStyle}
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
    >
      {!compact && (
        <Text bold color={colors.brand}>
          Output (Logs &amp; Responses)
        </Text>
      )}

      {!hasContent && (
        <Text color={colors.muted}>
          {searchActive
            ? `No messages match "${searchQuery}".`
            : '█ System initialized. Awaiting commands... Press [?] for help.'}
        </Text>
      )}

      {/* ── Message history ─────────────────────────────────── */}
      {visibleMessages.map((msg) => (
        <MessageLine key={msg.id} message={msg} />
      ))}

      {/* ── Activity events ──────────────────────────────────── */}
      {recentActivity.map((event) => (
        <ActivityLine key={event.id} event={event} />
      ))}

      {/* ── Streaming response ───────────────────────────────── */}
      {isStreaming && <StreamingLine text={streamingText} />}
    </Box>
  );
});

OutputArea.displayName = 'OutputArea';

// ==========================================================================
// Sub-components — all memoized to prevent unnecessary re-renders
// ==========================================================================

const MessageLine: React.FC<{ message: ChatMessageData }> = memo(({ message }) => {
  const { color, prefix } = getMessageStyle(message.role);

  if (message.role === 'agent') {
    const findingStyle = getFindingStyle(message.text);
    if (findingStyle) {
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={findingStyle.gutterColor}>█ </Text>
            <Text bold color={findingStyle.labelColor}>{findingStyle.label}</Text>
            <Text wrap="wrap">{findingStyle.rest}</Text>
          </Text>
          {findingStyle.codeBlocks.map((block, i) => (
            <CodeBlock code={block} key={`cb-${i}`} />
          ))}
        </Box>
      );
    }
  }

  const codeBlocks = extractCodeBlocks(message.text);
  if (codeBlocks.length > 0 && message.role === 'agent') {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={color}>█ </Text>
          <Text bold color={color}>{prefix} </Text>
          <Text wrap="wrap">{removeCodeBlocks(message.text)}</Text>
        </Text>
        {codeBlocks.map((block, i) => (
          <CodeBlock code={block} key={`cb-${i}`} />
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>█ </Text>
        <Text bold color={color}>{prefix} </Text>
        {message.role === 'user' ? (
          <Text color={color}>{message.text}</Text>
        ) : (
          <Text wrap="wrap">{message.text}</Text>
        )}
      </Text>
    </Box>
  );
});

MessageLine.displayName = 'MessageLine';

const ActivityLine: React.FC<{
  event: { id: string; kind: string; text: string };
}> = memo(({ event }) => (
  <Text>
    <Text color={getActivityColor(event.kind)}>█ </Text>
    <Text bold color={getActivityColor(event.kind)}>{getActivityPrefix(event.kind)} </Text>
    <Text wrap="wrap">{event.text}</Text>
  </Text>
));

ActivityLine.displayName = 'ActivityLine';

const StreamingLine: React.FC<{ text: string }> = memo(({ text }) => {
  if (text) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={colors.agent}>█ </Text>
          <Text wrap="wrap">{text}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Text>
      <Text color={colors.agent}>█ </Text>
      <Text color={colors.agent}><Spinner type="dots" /></Text>
      <Text color={colors.muted}> Streaming response...</Text>
    </Text>
  );
});

StreamingLine.displayName = 'StreamingLine';

const CodeBlock: React.FC<{ code: string }> = memo(({ code }) => (
  <Box borderColor={colors.dim} borderStyle="single" flexDirection="column" paddingX={1}>
    <Text wrap="wrap">{code}</Text>
  </Box>
));

CodeBlock.displayName = 'CodeBlock';

// ==========================================================================
// Helpers
// ==========================================================================

function getMessageStyle(role: ChatMessageData['role']): { color: string; prefix: string } {
  switch (role) {
    case 'agent': return { color: colors.agent, prefix: '◆' };
    case 'error': return { color: colors.error, prefix: '✖' };
    case 'system': return { color: colors.system, prefix: '●' };
    case 'user': return { color: colors.user, prefix: '❯' };
    default: return { color: colors.muted, prefix: '•' };
  }
}

function getFindingStyle(text: string): null | {
  codeBlocks: string[];
  gutterColor: string;
  label: string;
  labelColor: string;
  rest: string;
} {
  const hitMatch = text.match(/^\[Hit\]\s*(.*)/s);
  if (hitMatch) {
    const blocks = extractCodeBlocks(hitMatch[1]);
    return {
      codeBlocks: blocks,
      gutterColor: colors.info,
      label: '[Hit]',
      labelColor: colors.info,
      rest: removeCodeBlocks(hitMatch[1]),
    };
  }
  const alertMatch = text.match(/^\[Alert\]\s*(.*)/s);
  if (alertMatch) {
    const blocks = extractCodeBlocks(alertMatch[1]);
    return {
      codeBlocks: blocks,
      gutterColor: colors.error,
      label: '[Alert]',
      labelColor: colors.error,
      rest: removeCodeBlocks(alertMatch[1]),
    };
  }
  return null;
}

function extractCodeBlocks(text: string): string[] {
  const regex = /```[\s\S]*?```/g;
  const blocks: string[] = [];
  let match = regex.exec(text);
  while (match !== null) {
    blocks.push(match[0].replace(/^```[\w]*\n?/, '').replace(/\n?```$/, ''));
    match = regex.exec(text);
  }
  return blocks;
}

function removeCodeBlocks(text: string): string {
  return text.replaceAll(/```[\s\S]*?```/g, '').trim();
}

function getActivityColor(kind: string): string {
  switch (kind) {
    case 'status': return colors.info;
    case 'tool_call': return colors.pending;
    case 'tool_result': return colors.success;
    default: return colors.muted;
  }
}

function getActivityPrefix(kind: string): string {
  switch (kind) {
    case 'status': return '●';
    case 'tool_call': return '▶';
    case 'tool_result': return '✓';
    default: return '•';
  }
}

function applyFilters(
  messages: ChatMessageData[],
  filters: Record<string, boolean>,
): ChatMessageData[] {
  const activeFilters = Object.entries(filters).filter(([, v]) => v);
  if (activeFilters.length === 0) return messages;
  return messages.filter((msg) =>
    activeFilters.some(([key]) => msg.text.toLowerCase().includes(key.toLowerCase())),
  );
}
