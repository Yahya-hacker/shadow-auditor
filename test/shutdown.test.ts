import { expect } from 'chai';

import { createShutdownCoordinator } from '../src/ui/shutdown.js';

describe('shutdown coordinator', () => {
  it('runs cleanup once and shares the in-flight shutdown', async () => {
    let finishCleanup: (() => void) | undefined;
    let invocations = 0;
    const coordinator = createShutdownCoordinator(async () => {
      invocations += 1;
      await new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
    });

    const first = coordinator.request(0);
    const second = coordinator.request(1);

    expect(coordinator.isShuttingDown()).to.equal(true);
    expect(second).to.equal(first);
    expect(invocations).to.equal(1);

    finishCleanup?.();
    await first;
  });

  it('propagates cleanup failures to the caller', async () => {
    const failure = new Error('cleanup failed');
    const coordinator = createShutdownCoordinator(async () => {
      throw failure;
    });

    let caught: unknown;
    try {
      await coordinator.request();
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(failure);
  });
});
