import { expect } from 'chai';

import { isTruncatedResponse, stitchResponseChunks } from '../src/core/session.js';

describe('session continuation stitching', () => {
  it('merges chunks with overlap deduplication', () => {
    const merged = stitchResponseChunks(
      'Root cause: unsafe eval leads to command injection.',
      'eval leads to command injection. Mitigation: remove eval.',
    );

    expect(merged).to.equal('Root cause: unsafe eval leads to command injection. Mitigation: remove eval.');
  });

  it('appends chunks without overlap', () => {
    const merged = stitchResponseChunks('First segment.', ' Second segment.');
    expect(merged).to.equal('First segment. Second segment.');
  });

  it('detects truncation from finish metadata', () => {
    expect(isTruncatedResponse('length')).to.equal(true);
    expect(isTruncatedResponse('stop', 'max_tokens')).to.equal(true);
    expect(isTruncatedResponse('stop', 'stop')).to.equal(false);
  });
});
