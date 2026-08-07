import { expect } from 'chai';

import { resumeRestoredSession } from '../src/ui/resume-session.js';
import { useAppStore } from '../src/ui/store/appStore.js';

describe('restored interactive sessions', () => {
  beforeEach(() => {
    useAppStore.getState().clearActivity();
    useAppStore.getState().clearChat();
  });

  it('continues a non-paused checkpoint through the normal streaming path', async () => {
    let resumed = false;

    await resumeRestoredSession({
      async resumeFromCheckpoint(onChunk, onEvent) {
        resumed = true;
        onEvent?.({
          kind: 'status',
          message: 'Resuming interrupted workflow.',
          timestamp: '2026-08-05T00:00:00.000Z',
        });
        onChunk('# Restored report');
        return '# Restored report';
      },
    });

    const state = useAppStore.getState();
    expect(resumed).to.equal(true);
    expect(state.streaming).to.equal(false);
    expect(state.messages.at(-1)).to.include({
      role: 'agent',
      text: '# Restored report',
    });
    expect(state.activity.at(-1)?.text).to.equal('Resuming interrupted workflow.');
  });

  it('leaves streaming state clean when checkpoint continuation fails', async () => {
    let error: unknown;
    try {
      await resumeRestoredSession({
        async resumeFromCheckpoint() {
          throw new Error('checkpoint is corrupt');
        },
      });
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error).with.property('message', 'checkpoint is corrupt');
    expect(useAppStore.getState().streaming).to.equal(false);
  });
});
