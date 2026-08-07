import { type DOMElement, Box as InkBox, measureElement } from 'ink';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
/**
 * OutputArea — dashboard transcript and activity display.
 *
 * Messages render inside a bounded, scrollable viewport that stays within the
 * dashboard (above the status bar) instead of spilling into terminal
 * scrollback. The viewport height is measured via Ink's measureElement; the
 * inner content box is shifted up with a negative marginTop and clipped by
 * `overflow: 'hidden'`, giving in-app scroll that never exceeds the terminal
 * height (so the frame diffs cleanly and does not flicker). Scroll position
 * lives in the store as `outputScroll` — lines up from the bottom, 0 = pinned
 * to the latest (auto-follows new output).
 */

import { Box, Text } from "../primitives.js";
import { type ActivityEvent, type ChatMessageData } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

interface OutputAreaProps {
  compact?: boolean;
}

export function selectRecentActivity(
  activity: ActivityEvent[],
  filters: Record<string, boolean>,
  findingIds: ReadonlySet<string> = new Set(),
): ActivityEvent[] {
  return activity.filter((event) => {
    if (
      filters.findings &&
      [...findingIds].some((id) =>
        event.text.includes(id) ||
        event.detail?.includes(id) ||
        event.resultPreview?.includes(id)
      )
    ) return true;
    if (event.kind === 'tool_call' || event.kind === 'tool_result') return filters.tool_calls;
    return filters.agent;
  });
}

export function resolveBottomRelativeScroll(
  outputScroll: number,
  previousMaxScroll: null | number,
  maxScroll: number,
): number {
  if (previousMaxScroll === null) return Math.min(outputScroll, maxScroll);
  const growth = maxScroll - previousMaxScroll;
  if (outputScroll > 0 && growth > 0) {
    return Math.min(maxScroll, outputScroll + growth);
  }

  return Math.min(outputScroll, maxScroll);
}

export const OutputArea: React.FC<OutputAreaProps> = memo(({ compact = false }) => {
  const messages = useAppStore((s) => s.messages);
  const searchActive = useAppStore((s) => s.searchActive);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const isStreaming = useAppStore((s) => s.streaming);
  const streamingText = useAppStore((s) => s.streamingText);
  const activity = useAppStore((s) => s.activity);
  const filters = useAppStore((s) => s.filters);
  const currentVulnerabilityIds = useAppStore((s) => s.currentVulnerabilityIds);
  const verifiedFindingIds = useAppStore((s) => s.verifiedFindingIds);
  const findingIds = useMemo(
    () => new Set([...currentVulnerabilityIds, ...verifiedFindingIds]),
    [currentVulnerabilityIds, verifiedFindingIds],
  );

  const visibleMessages = useMemo(
    () => applyFilters(messages, filters, findingIds),
    [filters, findingIds, messages],
  );

  const recentActivity = useMemo(
    () => selectRecentActivity(activity, filters, findingIds),
    [activity, filters, findingIds],
  );
  const timeline = useMemo(() => {
    const merged = [
      ...visibleMessages.map((message) => ({kind: 'message' as const, message, sequence: message.sequence ?? 0})),
      ...recentActivity.map((event) => ({event, kind: 'activity' as const, sequence: event.sequence ?? Number.MAX_SAFE_INTEGER})),
    ].sort((left, right) => left.sequence - right.sequence);
    const query = searchActive ? searchQuery.trim().toLowerCase() : '';
    if (!query) return merged;
    return merged.filter((item) => {
      const searchable = item.kind === 'message'
        ? item.message.text
        : [item.event.agent, item.event.text, item.event.detail, item.event.resultPreview]
          .filter(Boolean)
          .join(' ');
      return searchable.toLowerCase().includes(query);
    });
  }, [recentActivity, searchActive, searchQuery, visibleMessages]);
  const hasContent = visibleMessages.length > 0 || isStreaming || recentActivity.length > 0;

  // ── Scroll state ──────────────────────────────────────────────────
  // `outputScroll` = lines up from the bottom (0 = pinned to latest). Viewport
  // and content heights are measured post-render; the content box is shifted
  // up by `offsetFromTop` and clipped by the viewport's overflow.
  const outputScroll = useAppStore((s) => s.outputScroll);
  const setOutputScroll = useAppStore((s) => s.setOutputScroll);
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const previousMaxScroll = useRef<null | number>(null);

  useEffect(() => {
    if (viewportRef.current) {
      const h = measureElement(viewportRef.current).height;
      if (h !== viewportHeight) setViewportHeight(h);
    }

    if (contentRef.current) {
      const h = measureElement(contentRef.current).height;
      if (h !== contentHeight) setContentHeight(h);
    }
  });

  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  useEffect(() => {
    const nextScroll = resolveBottomRelativeScroll(
      outputScroll,
      previousMaxScroll.current,
      maxScroll,
    );
    previousMaxScroll.current = maxScroll;
    if (nextScroll !== outputScroll) setOutputScroll(nextScroll);
  }, [outputScroll, maxScroll, setOutputScroll]);
  const offsetFromTop = maxScroll - Math.min(outputScroll, maxScroll);
  const canScrollUp = offsetFromTop > 0;
  const canScrollDown = offsetFromTop < maxScroll;
  const scrollHint = maxScroll > 0 ? `  ${canScrollUp ? '↑' : ' '}${canScrollDown ? '↓' : ' '} scroll` : '';

  // ── Search/filter view: a plain list so the visible set can change freely.
  if (searchActive) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {!compact && (
          <Text bold color={colors.brand}>
            Output (Logs &amp; Responses)
          </Text>
        )}
        {timeline.length === 0 ? (
          <Text color={colors.muted}>{`No timeline entries match "${searchQuery}".`}</Text>
        ) : (
          timeline.map((item) => item.kind === 'message'
            ? <MessageLine key={`message-${item.message.id}`} message={item.message} />
            : <ActivityLine event={item.event} key={`activity-${item.event.id}`} />)
        )}
      </Box>
    );
  }

  // ── Normal view: bounded, scrollable viewport that never passes the status bar.
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {!compact && (
        <Text bold color={colors.brand}>
          Output (Logs &amp; Responses){scrollHint}
        </Text>
      )}

      <InkBox flexDirection="column" flexGrow={1} overflow="hidden" ref={viewportRef}>
        <InkBox flexDirection="column" flexShrink={0} marginTop={-offsetFromTop} ref={contentRef}>
          {!hasContent && (
            <Text color={colors.muted}>
              █ System initialized. Awaiting commands... Press [?] for help.
            </Text>
          )}

          {timeline.map((item) => item.kind === 'message'
            ? <MessageLine key={`message-${item.message.id}`} message={item.message} />
            : <ActivityLine event={item.event} key={`activity-${item.event.id}`} />)}

          {isStreaming && streamingText && <StreamingLine text={streamingText} />}
          {isStreaming && !streamingText && recentActivity.length === 0 && <StreamingLine text="" />}

        </InkBox>
      </InkBox>
    </Box>
  );
});

OutputArea.displayName = 'OutputArea';

// ==========================================================================
// Sub-components — all memoized
// ==========================================================================

const MessageLine: React.FC<{ message: ChatMessageData }> = memo(({ message }) => {
  const { color, prefix } = getMessageStyle(message.role);

  if (message.role === 'agent') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={color}>{prefix} Shadow <Text color={colors.muted}>[Reporting Agent]</Text></Text>
        <Box marginLeft={2}>
          <MarkdownRenderer content={message.text} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={color}>█ </Text>
        <Text bold color={color}>{prefix} </Text>
        <Text color={message.role === 'user' ? color : undefined}>{message.text}</Text>
      </Text>
    </Box>
  );
});
MessageLine.displayName = 'MessageLine';

const ActivityLine: React.FC<{ event: ActivityEvent }> = memo(({ event }) => {
  const color = getActivityColor(event.kind, event.succeeded);
  const isTool = event.kind === 'tool_call' || event.kind === 'tool_result';

  if (isTool) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={color}>
          {getActivityPrefix(event.kind, event.succeeded)}{event.agent ? ` [${event.agent}]` : ''} {event.text}
        </Text>
        {event.detail && (
          <Text color={colors.bright}>  │ {event.detail}</Text>
        )}
        {event.resultPreview && (
          <Text color={colors.muted}>  └ {event.resultPreview}</Text>
        )}
      </Box>
    );
  }

  return (
    <Text color={colors.muted}>
      <Text bold color={color}>{getActivityPrefix(event.kind)} </Text>
      {event.agent ? <Text bold color={color}>[{event.agent}] </Text> : null}
      {event.text}
    </Text>
  );
});
ActivityLine.displayName = 'ActivityLine';

const StreamingLine: React.FC<{ text: string }> = memo(({ text }) => {
  if (text) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={colors.agent}>◆ Shadow <Text color={colors.muted}>[Reporting Agent]</Text></Text>
        <Box marginLeft={2}>
          <MarkdownRenderer content={text} isStreaming />
        </Box>
      </Box>
    );
  }

  return (
    <Text>
      <Text color={colors.agent}>█ </Text>
      <Text animate="pulse" color={colors.agent}>●</Text>
      <Text color={colors.muted}> Streaming response...</Text>
    </Text>
  );
});
StreamingLine.displayName = 'StreamingLine';

// ==========================================================================
// Helpers
// ==========================================================================

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

function getActivityColor(kind: string, succeeded?: boolean): string {
  if (kind === 'tool_result' && succeeded === false) return colors.error;
  switch (kind) {
    case 'agent_progress': { return colors.agent;
    }

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

function getActivityPrefix(kind: string, succeeded?: boolean): string {
  if (kind === 'tool_result' && succeeded === false) return '✖';
  switch (kind) {
    case 'agent_progress': { return '◆';
    }

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

function applyFilters(
  messages: ChatMessageData[],
  filters: Record<string, boolean>,
  findingIds: ReadonlySet<string>,
): ChatMessageData[] {
  if (filters.all) return messages;

  return messages.filter((message) => {
    const isFinding = message.role === 'agent' &&
      [...findingIds].some((id) => message.text.includes(id));
    if (filters.findings && isFinding) return true;
    if (filters.agent && message.role === 'agent' && !isFinding) return true;
    if (filters.errors && message.role === 'error') return true;
    if (filters.agent && message.role === 'system') return true;
    return filters.user && message.role === 'user';
  });
}
