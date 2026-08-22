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

      it('restores the persisted transcript into the chat history before resuming', async () => {
        await resumeRestoredSession({
          async getMessageHistory() {
            return [
              {content: 'what did you find?', role: 'user', timestamp: '2026-08-05T00:00:00.000Z'},
              {content: [{text: 'I found a bug.', type: 'text'}], role: 'assistant', timestamp: '2026-08-05T00:00:01.000Z'},
              {content: 'internal tool noise', role: 'tool', timestamp: '2026-08-05T00:00:02.000Z'},
            ];
          },
          async resumeFromCheckpoint() {
            return 'Continuing.';
          },
        });

        const state = useAppStore.getState();
        expect(state.messages.map((message) => message.role)).to.deep.equal(['user', 'agent', 'agent']);
        expect(state.messages[0]).to.include({role: 'user', text: 'what did you find?'});
        expect(state.messages[1]).to.include({role: 'agent', text: 'I found a bug.'});
        // The continuation response is appended after the restored history.
        expect(state.messages[2]).to.include({role: 'agent', text: 'Continuing.'});
      });

      it('resumes even when the transcript cannot be read', async () => {
        let resumed = false;
        await resumeRestoredSession({
          async getMessageHistory() {
            throw new Error('transcript unreadable');
          },
          async resumeFromCheckpoint() {
            resumed = true;
            return 'Continuing.';
          },
        });

        expect(resumed).to.equal(true);
        expect(useAppStore.getState().streaming).to.equal(false);
      });
    });
