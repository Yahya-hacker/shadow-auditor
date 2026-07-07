/**
 * OutputArea — main chat/log display with native OpenTUI scrolling.
 *
 * Uses `overflowY="scroll"` on the container — no custom virtualization,
 * no Ink `<Static>` emulation. Yoga handles scrolling natively.
 * Auto-scroll to bottom is handled by OpenTUI's native behavior when
 * new content is appended to a scrollable container.
 */

import React, { memo, useMemo } from 'react';

import { type ChatMessageData } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle } from '../theme/chalkTheme.js';

interface OutputAreaProps {
  compact?: boolean;
}

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

  // ── Filter messages (memoized — only recomputes when deps change) ──
  const visibleMessages = useMemo(() => {
    const query = searchActive && searchQuery ? searchQuery.toLowerCase() : '';
    if (query) {
      return messages.filter((m) => m.text.toLowerCase().includes(query));
    }
    return applyFilters(messages, filters);
  }, [messages, searchActive, searchQuery, filters]);

  const recentActivity = useMemo(() => activity.slice(-3), [activity]);
  const hasContent = visibleMessages.length > 0 || isStreaming || recentActivity.length > 0;

  return (
    <box
      border={{ color: panelStyle.borderColor, style: panelStyle.borderStyle }}
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
    >
      {!compact && (
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>
          Output (Logs &amp; Responses)
        </text>
      )}

      {!hasContent && (
        <text style={{ color: colors.muted }}>
          {searchActive
            ? `No messages match "${searchQuery}".`
            : '█ System initialized. Awaiting commands... Press [?] for help.'}
        </text>
      )}

      {/* ── Message history with native scrolling ────────────────── */}
      <box flexDirection="column" flexGrow={1} overflowY="scroll">
        {visibleMessages.map((msg) => (
          <MessageLine key={msg.id} message={msg} />
        ))}

        {recentActivity.map((event) => (
          <ActivityLine key={event.id} event={event} />
        ))}

        {isStreaming && <StreamingLine text={streamingText} />}
      </box>
    </box>
  );
});

OutputArea.displayName = 'OutputArea';

// ==========================================================================
// Sub-components — all memoized
// ==========================================================================

const MessageLine: React.FC<{ message: ChatMessageData }> = memo(({ message }) => {
  const { color, prefix } = getMessageStyle(message.role);

  if (message.role === 'agent') {
    const findingStyle = getFindingStyle(message.text);
    if (findingStyle) {
      return (
        <box flexDirection="column">
          <text>
            <text style={{ color: findingStyle.gutterColor }}>█ </text>
            <text style={{ color: findingStyle.labelColor, fontWeight: 'bold' }}>
              {findingStyle.label}
            </text>
            <text>{findingStyle.rest}</text>
          </text>
          {findingStyle.codeBlocks.map((block, i) => (
            <CodeBlock code={block} key={`cb-${i}`} />
          ))}
        </box>
      );
    }
  }

  const codeBlocks = extractCodeBlocks(message.text);
  if (codeBlocks.length > 0 && message.role === 'agent') {
    return (
      <box flexDirection="column">
        <text>
          <text style={{ color }}>█ </text>
          <text style={{ color, fontWeight: 'bold' }}>{prefix} </text>
          <text>{removeCodeBlocks(message.text)}</text>
        </text>
        {codeBlocks.map((block, i) => (
          <CodeBlock code={block} key={`cb-${i}`} />
        ))}
      </box>
    );
  }

  return (
    <box flexDirection="column">
      <text>
        <text style={{ color }}>█ </text>
        <text style={{ color, fontWeight: 'bold' }}>{prefix} </text>
        {message.role === 'user' ? (
          <text style={{ color }}>{message.text}</text>
        ) : (
          <text>{message.text}</text>
        )}
      </text>
    </box>
  );
});
MessageLine.displayName = 'MessageLine';

const ActivityLine: React.FC<{
  event: { id: string; kind: string; text: string };
}> = memo(({ event }) => (
  <text>
    <text style={{ color: getActivityColor(event.kind) }}>█ </text>
    <text style={{ color: getActivityColor(event.kind), fontWeight: 'bold' }}>
      {getActivityPrefix(event.kind)}{' '}
    </text>
    <text>{event.text}</text>
  </text>
));
ActivityLine.displayName = 'ActivityLine';

const StreamingLine: React.FC<{ text: string }> = memo(({ text }) => {
  if (text) {
    return (
      <box flexDirection="column">
        <text>
          <text style={{ color: colors.agent }}>█ </text>
          <text>{text}</text>
        </text>
      </box>
    );
  }

  return (
    <text>
      <text style={{ color: colors.agent }}>█ </text>
      <text style={{ color: colors.agent }} animate="pulse">●</text>
      <text style={{ color: colors.muted }}> Streaming response...</text>
    </text>
  );
});
StreamingLine.displayName = 'StreamingLine';

const CodeBlock: React.FC<{ code: string }> = memo(({ code }) => (
  <box
    border={{ color: colors.dim, style: 'single' }}
    flexDirection="column"
    paddingX={1}
  >
    <text>{code}</text>
  </box>
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
    const blocks = extractCodeBlocks(hitMatch[1]!);
    return {
      codeBlocks: blocks,
      gutterColor: colors.info,
      label: '[Hit]',
      labelColor: colors.info,
      rest: removeCodeBlocks(hitMatch[1]!),
    };
  }
  const alertMatch = text.match(/^\[Alert\]\s*(.*)/s);
  if (alertMatch) {
    const blocks = extractCodeBlocks(alertMatch[1]!);
    return {
      codeBlocks: blocks,
      gutterColor: colors.error,
      label: '[Alert]',
      labelColor: colors.error,
      rest: removeCodeBlocks(alertMatch[1]!),
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
