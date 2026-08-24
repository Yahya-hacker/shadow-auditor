import {expect} from 'chai';

import {isSessionMetadata} from '../src/ui/screens/HistoryScreen.js';

describe('HistoryScreen session metadata validation', () => {
  it('accepts a well-formed session-meta.json payload', () => {
    expect(
      isSessionMetadata({
        completedAt: '2024-01-01T00:00:00.000Z',
        maxOutputTokens: 8000,
        maxToolSteps: 50,
        mcpEnabled: false,
        model: 'gpt-4o',
        provider: 'openai',
        runId: 'run-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        targetPath: '/repo',
        warnings: [],
      }),
    ).to.equal(true);
  });

  it('accepts a payload without an optional completedAt', () => {
    expect(
      isSessionMetadata({
        maxOutputTokens: 8000,
        maxToolSteps: 50,
        mcpEnabled: false,
        model: 'gpt-4o',
        provider: 'openai',
        runId: 'run-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        targetPath: '/repo',
        warnings: [],
      }),
    ).to.equal(true);
  });

  it('rejects a parsed null', () => {
    expect(isSessionMetadata(null)).to.equal(false);
  });

  it('rejects a parsed primitive', () => {
    expect(isSessionMetadata('not-an-object')).to.equal(false);
    expect(isSessionMetadata(42)).to.equal(false);
  });

  it('rejects an array', () => {
    expect(isSessionMetadata([])).to.equal(false);
  });

  it('rejects a payload missing required string fields', () => {
    expect(
      isSessionMetadata({
        maxOutputTokens: 8000,
        maxToolSteps: 50,
        mcpEnabled: false,
        model: 'gpt-4o',
        provider: 'openai',
        startedAt: '2024-01-01T00:00:00.000Z',
        targetPath: '/repo',
        warnings: [],
      }),
    ).to.equal(false);
  });

  it('rejects a payload with a non-array warnings field', () => {
    expect(
      isSessionMetadata({
        maxOutputTokens: 8000,
        maxToolSteps: 50,
        mcpEnabled: false,
        model: 'gpt-4o',
        provider: 'openai',
        runId: 'run-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        targetPath: '/repo',
        warnings: 'oops',
      }),
    ).to.equal(false);
  });

  it('rejects a payload with a non-string completedAt', () => {
    expect(
      isSessionMetadata({
        completedAt: 12_345,
        maxOutputTokens: 8000,
        maxToolSteps: 50,
        mcpEnabled: false,
        model: 'gpt-4o',
        provider: 'openai',
        runId: 'run-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        targetPath: '/repo',
        warnings: [],
      }),
    ).to.equal(false);
  });
});
