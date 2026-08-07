import {expect} from 'chai';

import {parseMarkdown} from '../src/ui/components/MarkdownRenderer.js';

describe('MarkdownRenderer', () => {
  it('preserves source-to-sink traces as structured semantic blocks', () => {
    const blocks = parseMarkdown(
      [
        '#### Data Flow',
        '',
        '📥 SOURCE `src/routes.ts:12`: Untrusted request parameter',
        '→ `src/service.ts:30`: Passed to the storage service',
        '🛡️ SANITIZER `src/service.ts:31`: Extension check only',
        '📤 SINK `src/files.ts:44`: File is read from disk',
      ].join('\n'),
      false,
    );

    expect(blocks).to.have.length(2);
    expect(blocks[1]).to.deep.equal({
      items: [
        {kind: 'source', text: '`src/routes.ts:12`: Untrusted request parameter'},
        {kind: 'flow', text: '`src/service.ts:30`: Passed to the storage service'},
        {kind: 'sanitizer', text: '`src/service.ts:31`: Extension check only'},
        {kind: 'sink', text: '`src/files.ts:44`: File is read from disk'},
      ],
      type: 'dataFlow',
    });
  });

  it('keeps data-flow lines separate from surrounding prose while streaming', () => {
    const blocks = parseMarkdown(
      'Context\n\n📥 SOURCE `src/a.ts:1`: input\n📤 SINK `src/b.ts:2`: execution\n\nImpact',
      true,
    );

    expect(blocks.map((block) => block.type)).to.deep.equal([
      'paragraph',
      'dataFlow',
      'paragraph',
    ]);
  });
});
