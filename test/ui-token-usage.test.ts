import {expect} from 'chai';

import {useAppStore} from '../src/ui/store/appStore.js';

describe('UI token accounting', () => {
  beforeEach(() => {
    useAppStore.getState().clearChat();
  });

  afterEach(() => {
    useAppStore.getState().clearChat();
  });

  it('marks a session mixed when provider and derived totals coexist', () => {
    useAppStore.getState().updateTokenUsage({
      completion: 3,
      prompt: 12,
      total: 20,
      totalSource: 'provider',
      unclassified: 5,
    });
    useAppStore.getState().updateTokenUsage({
      completion: 2,
      prompt: 8,
      total: 10,
      totalSource: 'derived',
    });

    expect(useAppStore.getState().tokenUsage).to.deep.equal({
      completion: 5,
      prompt: 20,
      provenance: 'mixed',
      total: 30,
      unclassified: 5,
    });
  });

  it('clears every token counter and its provenance with chat history', () => {
    useAppStore.getState().updateTokenUsage({
      total: 21,
      totalSource: 'provider',
      unclassified: 21,
    });

    useAppStore.getState().clearChat();

    expect(useAppStore.getState().tokenUsage).to.deep.equal({
      completion: 0,
      prompt: 0,
      provenance: 'unavailable',
      total: 0,
      unclassified: 0,
    });
  });
});
