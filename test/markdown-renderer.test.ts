import {expect} from 'chai';

import {parseInline, parseMarkdown} from '../src/ui/components/MarkdownRenderer.js';

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

    describe('MarkdownRenderer.parseInline', () => {
      it('parses triple-asterisk content as a single bold segment before the bold branch', () => {
        const segments = parseInline('***strong + emphasized***', false);
        expect(segments).to.deep.equal([{text: 'strong + emphasized', type: 'bold'}]);
      });

      it('does not leak a trailing star when bold content is wrapped in emphasis markers', () => {
        // Regression (#27): `**x***` used to leave a dangling `*` literal.
        const segments = parseInline('**bold** then *italic*', false);
        expect(segments).to.deep.equal([
          {text: 'bold', type: 'bold'},
          {text: ' then ', type: 'text'},
          {text: 'italic', type: 'italic'},
        ]);
      });

      it('keeps a balanced parenthesis inside a link URL instead of truncating it', () => {
        // Regression (#27): `indexOf(')')` stopped at the paren inside the URL.
        const segments = parseInline('[page](http://host/handler(a))', false);
        expect(segments).to.deep.equal([
          {text: 'page', type: 'link', url: 'http://host/handler(a)'},
        ]);
      });

      it('treats unbalanced parentheses in a link URL as literal text', () => {
        const segments = parseInline('open a [broken](http://host/(unclosed', false);
        expect(segments).to.deep.equal([
          {text: 'open a [broken](http://host/(unclosed', type: 'text'},
        ]);
      });
    });
