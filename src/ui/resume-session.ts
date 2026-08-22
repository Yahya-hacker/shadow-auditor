import type { AgentSessionLike } from './hooks/useAgentSession.js';

import { createThrottledStream } from './hooks/useAgentSubmit.js';
import { useAppStore } from './store/appStore.js';

/**
 * Extract a plain-text representation from a persisted message's `content`.
 * ModelMessage content may be a plain string or an array of `{type, text}`
 * content parts; we join the text parts so the transcript renders cleanly in
 * the chat history.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as {text: unknown}).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Map a persisted artifact role to a chat-slice message role.
 * Tool-internal messages are dropped; their activity is already shown in the
 * live activity stream while resuming.
 */
function toChatRole(role: string): 'agent' | 'error' | 'system' | 'user' | null {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'agent';
    case 'system':
      return 'system';
    default:
      return null;
  }
}

export async function resumeRestoredSession(
  session: Pick<AgentSessionLike, 'getMessageHistory' | 'resumeFromCheckpoint'>,
): Promise<void> {
  const store = useAppStore.getState();

  // Restore the persisted conversation transcript so the UI does not look
  // like a fresh session. Failures to read history are non-fatal.
  try {
    if (session.getMessageHistory) {
      const history = await session.getMessageHistory();
      store.restoreMessages(
        history
          .map((event) => {
            const role = toChatRole(event.role);
            const text = extractText(event.content);
            if (!role || !text.trim()) return null;
            return { id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, text };
          })
          .filter((m): m is {id: string; role: 'agent' | 'error' | 'system' | 'user'; text: string} => m !== null),
      );
    }
  } catch {
    // History restoration is best-effort; resume regardless.
  }

  store.clearActivity();
  store.startStreaming();
  const stream = createThrottledStream();

  try {
    const response = await session.resumeFromCheckpoint(stream.onChunk, stream.onEvent);
    stream.finish();
    useAppStore.getState().finishStreaming(response);
  } catch (error) {
    stream.finish();
    useAppStore.getState().finishStreaming();
    throw error;
  }
}
