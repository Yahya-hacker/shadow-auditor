import {expect} from 'chai';

import {createSandboxTools} from '../src/core/dast/sandbox-tools.js';

describe('sandbox read tools', () => {
  it('propagates cancellation to OAST log synchronization', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const tools = createSandboxTools({
      sandboxManager: {
        getMirage() {
          return {
            getCallbackLog: () => [],
            getCallbacksForDomain: () => [],
            async syncLog(signal?: AbortSignal) {
              receivedSignal = signal;
              return [];
            },
          };
        },
      } as never,
    });

    await tools.check_oast_logs.execute?.(
      {},
      {abortSignal: controller.signal} as never,
    );

    expect(receivedSignal).to.equal(controller.signal);
  });

  it('does not convert sandbox status cancellation into a normal tool result', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const tools = createSandboxTools({
      sandboxManager: {
        getMirage: () => ({}),
        async status(signal?: AbortSignal) {
          signal?.throwIfAborted();
          throw new Error('unreachable');
        },
      } as never,
    });
    let error: unknown;

    try {
      await tools.sandbox_status.execute?.(
        {},
        {abortSignal: controller.signal} as never,
      );
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal('cancelled');
  });

  it('rejects pre-cancelled OAST checks before synchronization', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    let synchronized = false;
    const tools = createSandboxTools({
      sandboxManager: {
        getMirage() {
          return {
            getCallbackLog: () => [],
            getCallbacksForDomain: () => [],
            async syncLog() {
              synchronized = true;
              return [];
            },
          };
        },
      } as never,
    });
    let error: unknown;

    try {
      await tools.check_oast_logs.execute?.(
        {},
        {abortSignal: controller.signal} as never,
      );
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal('cancelled');
    expect(synchronized).to.equal(false);
  });
});
