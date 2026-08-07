import type { AgentSessionLike } from './hooks/useAgentSession.js';

import { createThrottledStream } from './hooks/useAgentSubmit.js';
import { useAppStore } from './store/appStore.js';

export async function resumeRestoredSession(
  session: Pick<AgentSessionLike, 'resumeFromCheckpoint'>,
): Promise<void> {
  const store = useAppStore.getState();
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
