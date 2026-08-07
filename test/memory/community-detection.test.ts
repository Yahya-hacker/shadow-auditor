import { expect } from 'chai';
import { describe, it } from 'mocha';

import { detectCommunities } from '../../src/core/memory/community-detection.js';

describe('Community detection', () => {
  it('assigns every node to a community', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['d', 'e'],
    ];

    const result = await detectCommunities({ edges, nodes });
    expect(result.communities.size).to.equal(nodes.length);
    for (const node of nodes) {
      expect(result.communities.has(node)).to.be.true;
    }
  });

  it('handles an empty graph', async () => {
    const result = await detectCommunities({ edges: [], nodes: [] });
    expect(result.modularity).to.equal(0);
    expect(result.communities.size).to.equal(0);
  });
});
