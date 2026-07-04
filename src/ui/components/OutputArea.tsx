import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { memo, useMemo } from 'react';

import { type ChatMessageData } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle } from '../theme.js';

interface OutputAreaProps {
  /** Compact mode: reduced padding, no title in border. */
  compact?: boolean;
  /** Available body height (rows) for windowing the message list. */
  height: number;
}

/**
 * Main output area with dark background, █ gutter prefix, and integrated
 * streaming/activity rendering.
 *
 * ┌─ Output (Logs & Responses) ─────────────────────────────────────┐
 * │ █  System initialized. Awaiting commands...                     │
 * │ █  Press [?] for help.                                          │
 * │ █                                                               │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Focus-driven border: single (idle) → double + blue (focused). Each message
 * line is prefixed with a █ gutter character. Activity events and streaming
 * responses are rendered inline. Code blocks in agent messages are boxed.
 */
export const OutputArea: React.FC<OutputAreaProps> = ({ compact = false, height }) => {
  const messages = useAppStore((state) => state.messages);
  const scrollOffset = useAppStore((state) => state.scrollOffset);
  const searchActive = useAppStore((state) => state.searchActive);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const isStreaming = useAppStore((state) => state.streaming);
  const streamingText = useAppStore((state) => state.streamingText);
  const activity = useAppStore((state) => state.activity);
  const focus = useAppStore((state) => state.focus);
  const filters = useAppStore((state) => state.filters);

  const isFocused = focus === 'output';
  const panelStyle = getPanelStyle(isFocused);

  // Build the combined output stream: messages + activity events.
  // Memoized to avoid recomputing on every keystroke (e.g. while typing in
  // the InputArea). Only recalculates when the source data actually changes.
  const allLines: Array<OutputLine> = useMemo(() => {
    const lines: Array<OutputLine> = [];

    // Add messages
    const query = searchActive && searchQuery ? searchQuery.toLowerCase() : '';
    const filteredMessages = query
      ? messages.filter((m) => m.text.toLowerCase().includes(query))
      : applyFilters(messages, filters);

    for (const msg of filteredMessages) {
      lines.push({ data: msg, kind: 'message' });
    }

    // Add activity events (last 8)
    const visibleActivity = activity.slice(-8);
    for (const event of visibleActivity) {
      lines.push({ data: event, kind: 'activity' });
    }

    // Add streaming response
    if (isStreaming && streamingText) {
      lines.push({ kind: 'streaming', text: streamingText });
    } else if (isStreaming) {
      lines.push({ kind: 'streaming-spin' });
    }

    return lines;
  }, [messages, activity, isStreaming, streamingText, searchActive, searchQuery, filters]);

  if (allLines.length === 0) {
    return (
      <Box
        borderColor={panelStyle.borderColor}
        borderStyle={panelStyle.borderStyle}
        flexDirection="column"
        flexGrow={1}
        paddingX={1}
      >
        {searchActive && (
          <Text color={colors.muted}>
            No messages match &quot;{searchQuery}&quot;.
          </Text>
        )}
        {!searchActive && (
          <Text color={colors.muted}>
            {'█'} System initialized. Awaiting commands... Press [?] for help.
          </Text>
        )}
      </Box>
    );
  }

  // Windowed rendering: each message occupies ~2 rows
  const maxVisible = Math.max(1, Math.floor((height - 4) / 2));
  const effectiveOffset = Math.min(scrollOffset, Math.max(0, allLines.length - maxVisible));
  const end = allLines.length - effectiveOffset;
  const start = Math.max(0, end - maxVisible);
  const windowLines = allLines.slice(start, end);
  const earlier = start;
  const newer = effectiveOffset;

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
      {earlier > 0 && (
        <Text color={colors.dim}>
          ↑ {earlier} earlier message{earlier === 1 ? '' : 's'}
          {searchActive ? ' (filtered)' : ''}
        </Text>
      )}
      {windowLines.map((line, index) => (
        <OutputLineRenderer key={outputLineKey(line, index)} line={line} />
      ))}
      {newer > 0 && (
        <Text color={colors.dim}>
          ↓ {newer} newer message{newer === 1 ? '' : 's'} (press j to follow)
        </Text>
      )}
    </Box>
  );
};

/** Output line types for the combined stream. */
type OutputLine =
  | { data: ChatMessageData; kind: 'message' }
  | { data: { id: string; kind: string; text: string }; kind: 'activity' }
  | { kind: 'streaming'; text: string }
  | { kind: 'streaming-spin' };

/** Generate a stable key for an output line to prevent remounting on scroll/filter. */
function outputLineKey(line: OutputLine, index: number): string {
  switch (line.kind) {
    case 'message': return `msg-${line.data.id}`;
    case 'activity': return `act-${line.data.id}`;
    case 'streaming': return `stream-${index}`;
    case 'streaming-spin': return 'stream-spin';
  }
}

/** Render a single output line with █ gutter prefix. Memoized to prevent
 *  all visible lines from re-rendering on every streaming chunk. */
const OutputLineRenderer: React.FC<{ line: OutputLine }> = memo(({ line }) => {
  switch (line.kind) {
    case 'activity': {
      const event = line.data;
      const actColor = getActivityColor(event.kind);
      const actPrefix = getActivityPrefix(event.kind);
      return (
        <Text>
          <Text color={actColor}>█ </Text>
          <Text bold color={actColor}>{actPrefix} </Text>
          <Text wrap="wrap">{event.text}</Text>
        </Text>
      );
    }

    case 'message': {
      const msg = line.data;
      const { color, prefix } = getMessageStyle(msg.role);

      // Check for finding/alert prefixes in the text
      if (msg.role === 'agent') {
        const findingStyle = getFindingStyle(msg.text);
        if (findingStyle) {
          return (
            <Box flexDirection="column">
              <Text>
                <Text color={findingStyle.gutterColor}>█ </Text>
                <Text bold color={findingStyle.labelColor}>{findingStyle.label}</Text>
                <Text wrap="wrap">{findingStyle.rest}</Text>
              </Text>
              {/* Render code blocks inline */}
              {findingStyle.codeBlocks.map((block, i) => (
                <CodeBlock code={block} key={`cb-${i}`} />
              ))}
            </Box>
          );
        }
      }

      // Check for code blocks in any agent message
      const codeBlocks = extractCodeBlocks(msg.text);
      if (codeBlocks.length > 0 && msg.role === 'agent') {
        const textWithoutBlocks = removeCodeBlocks(msg.text);
        return (
          <Box flexDirection="column">
            <Text>
              <Text color={color}>█ </Text>
              <Text bold color={color}>{prefix} </Text>
              <Text wrap="wrap">{textWithoutBlocks}</Text>
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
            {msg.role === 'user' ? (
              <Text color={color}>{msg.text}</Text>
            ) : (
              <Text wrap="wrap">{msg.text}</Text>
            )}
          </Text>
        </Box>
      );
    }

    case 'streaming': {
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={colors.agent}>█ </Text>
            <Text color={colors.agent}>
              <Spinner type="dots" />
            </Text>
            <Text wrap="wrap">{line.text}</Text>
          </Text>
        </Box>
      );
    }

    case 'streaming-spin': {
      return (
        <Text>
          <Text color={colors.agent}>█ </Text>
          <Text color={colors.agent}>
            <Spinner type="dots" />
          </Text>
          <Text color={colors.muted}> Streaming response...</Text>
        </Text>
      );
    }
  }
});

OutputLineRenderer.displayName = 'OutputLineRenderer';

/** Bordered code block sub-component. */
const CodeBlock: React.FC<{ code: string }> = ({ code }) => (
  <Box
    borderColor={colors.dim}
    borderStyle="single"
    flexDirection="column"
    paddingX={1}
  >
    <Text wrap="wrap">{code}</Text>
  </Box>
);

function getMessageStyle(role: ChatMessageData['role']): { color: string; prefix: string } {
  switch (role) {
    case 'agent': { return { color: colors.agent, prefix: '◆' };
    }

    case 'error': { return { color: colors.error, prefix: '✖' };
    }

    case 'system': { return { color: colors.system, prefix: '●' };
    }

    case 'user': { return { color: colors.user, prefix: '❯' };
    }

    default: { return { color: colors.muted, prefix: '•' };
    }
  }
}

function getFindingStyle(text: string): null | { codeBlocks: string[]; gutterColor: string; label: string; labelColor: string; rest: string } {
  // Match [Hit] or [Alert] prefixes
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
    // Strip the ``` fences
    const block = match[0].replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    blocks.push(block);
    match = regex.exec(text);
  }

  return blocks;
}

function removeCodeBlocks(text: string): string {
  return text.replaceAll(/```[\s\S]*?```/g, '').trim();
}

function getActivityColor(kind: string): string {
  switch (kind) {
    case 'status': { return colors.info;
    }

    case 'tool_call': { return colors.pending;
    }

    case 'tool_result': { return colors.success;
    }

    default: { return colors.muted;
    }
  }
}

function getActivityPrefix(kind: string): string {
  switch (kind) {
    case 'status': { return '●';
    }

    case 'tool_call': { return '▶';
    }

    case 'tool_result': { return '✓';
    }

    default: { return '•';
    }
  }
}

/**
 * Apply active filters to messages. Only filters that are enabled (true) are
 * used to filter; messages must match at least one enabled filter's substring
 * to pass, unless no filters are enabled (in which case all pass).
 */
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
