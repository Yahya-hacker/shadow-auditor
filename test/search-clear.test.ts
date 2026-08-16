import {expect} from 'chai';

import {useAppStore} from '../src/ui/store/appStore.js';

describe('Search-mode clear (#28)', () => {
  beforeEach(() => {
    const s = useAppStore.getState();
    s.setSearchActive(false);
    s.setSearchQuery('');
  });

  it('clears a non-empty search query when search mode is deactivated', () => {
    const s = useAppStore.getState();
    s.setSearchActive(true);
    s.setSearchQuery('sensitive');

    // What the ShellScreen Escape handler now does: exit search AND clear the
    // query, so a later `/` re-entry does not resurrect a stale filter.
    s.setSearchActive(false);
    s.setSearchQuery('');

    const after = useAppStore.getState();
    expect(after.searchActive).to.equal(false);
    expect(after.searchQuery).to.equal('');
  });
});