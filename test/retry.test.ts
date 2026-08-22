import {expect} from 'chai';

import {withRetry} from '../src/core/memory/embeddings/retry.js';

describe('shared retry policy', () => {
  it('retries provider streaming rate-limit errors', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error('Request throttled'), {
            code: 'rate_limit_exceeded',
            retryAfterMs: 0,
            type: 'too_many_requests',
          });
        }

        return 'ok';
      },
      1,
      0,
    );

    expect(result).to.equal('ok');
    expect(attempts).to.equal(2);
  });

  it('cancels a pending retry without another invocation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    let attempts = 0;
    const operation = withRetry(
      async () => {
        attempts++;
        throw Object.assign(new Error('rate limited'), {
          code: 'rate_limit_exceeded',
        });
      },
      2,
      60_000,
      controller.signal,
    );
    controller.abort(reason);

    let error: unknown;
    try {
      await operation;
    } catch (error_) {
      error = error_;
    }

    expect(error).to.equal(reason);
    expect(attempts).to.equal(1);
  });
});
