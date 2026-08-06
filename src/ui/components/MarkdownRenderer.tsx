/**
 * MarkdownRenderer — Streaming-capable markdown renderer for OpenTUI.
 *
 * Parses a subset of GitHub Flavored Markdown (headers, bold/italic, code
 * blocks with language labels, inline code, lists, links, blockquotes) and
 * renders using OpenTUI Box/Text primitives. When `isStreaming` is true,
 * partial elements (unclosed fences, dangling bold markers) are rendered as
 * plain text until completed.
 */

import React, { memo, useMemo } from 'react';

import { Box, Text } from '../primitives.js';
import { colors } from '../theme/chalkTheme.js';

// ── Public API ──────────────────────────────────────────────────────────────

export interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = memo(
  ({ content, isStreaming = false }) => {
    const blocks = useMemo(() => parseMarkdown(content, isStreaming), [content, isStreaming]);
    return (
      <Box flexDirection="column">
        {blocks.map((block, i) => (
          <RenderBlock block={block} key={i} streaming={isStreaming} />
        ))}
      </Box>
    );
  },
);
MarkdownRenderer.displayName = 'MarkdownRenderer';

// ── Block types ──────────────────────────────────────────────────────────────

interface HeadingBlock {
  level: number;
  text: string;
  type: 'heading';
}

interface CodeBlockBlock {
  code: string;
  language: string;
  type: 'codeBlock';
}

interface ParagraphBlock {
  text: string;
  type: 'paragraph';
}

interface ListItemBlock {
  items: string[];
  ordered: boolean;
  type: 'list';
}

interface BlockquoteBlock {
  text: string;
  type: 'blockquote';
}

interface HorizontalRuleBlock {
  type: 'hr';
}

export interface DataFlowBlock {
  items: Array<{
    kind: 'flow' | 'sanitizer' | 'sink' | 'source';
    text: string;
  }>;
  type: 'dataFlow';
}

type Block =
  | BlockquoteBlock
  | CodeBlockBlock
  | DataFlowBlock
  | HeadingBlock
  | HorizontalRuleBlock
  | ListItemBlock
  | ParagraphBlock;

// ── Inline segment types ─────────────────────────────────────────────────────

interface InlineText {
  text: string;
  type: 'text';
}

interface InlineBold {
  text: string;
  type: 'bold';
}

interface InlineItalic {
  text: string;
  type: 'italic';
}

interface InlineCode {
  text: string;
  type: 'code';
}

interface InlineLink {
  text: string;
  type: 'link';
  url: string;
}

type InlineSegment = InlineBold | InlineCode | InlineItalic | InlineLink | InlineText;

// ── Parser ───────────────────────────────────────────────────────────────────

const DATA_FLOW_LINE = /^(📥 SOURCE|📤 SINK|🛡️ SANITIZER|→)\s+(.*)$/;

export function parseMarkdown(raw: string, streaming: boolean): Block[] {
  const blocks: Block[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // ── Fenced code block ──────────────────────────────────────────────────
    if (/^```\w*$/.test(line.trimStart())) {
      const lang = line.trim().replace(/^```/, '').trim();
      const codeLines: string[] = [];
      let closed = false;
      let j = i + 1;
      while (j < lines.length) {
        if (/^```\s*$/.test(lines[j]!.trimStart())) {
          closed = true;
          break;
        }

        codeLines.push(lines[j]!);
        j++;
      }

      // In streaming mode, render unclosed fence as code block with what we have
      if (closed || streaming) {
        blocks.push({ code: codeLines.join('\n'), language: lang, type: 'codeBlock' });
        i = closed ? j + 1 : lines.length;
        continue;
      }

      // Not streaming & not closed: render opening fence as paragraph text
      blocks.push({ text: line, type: 'paragraph' });
      i++;
      continue;
    }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^(---+|___+|\*\*\*+)\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // ── Heading ─────────────────────────────────────────────────────────────
    const headingMatch = /^(#{1,6})\s+(.*)/.exec(line);
    if (headingMatch) {
      blocks.push({
        level: headingMatch[1]!.length,
        text: headingMatch[2]!,
        type: 'heading',
      });
      i++;
      continue;
    }

    // ── Blockquote ──────────────────────────────────────────────────────────
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j]!)) {
        quoteLines.push(lines[j]!.replace(/^>\s?/, ''));
        j++;
      }

      blocks.push({ text: quoteLines.join(' '), type: 'blockquote' });
      i = j;
      continue;
    }

    // ── Security data-flow trace ────────────────────────────────────────────
    if (DATA_FLOW_LINE.test(line)) {
      const items: DataFlowBlock['items'] = [];
      let j = i;
      while (j < lines.length) {
        const match = DATA_FLOW_LINE.exec(lines[j]!);
        if (!match) break;
        const kind =
          match[1] === '📥 SOURCE'
            ? 'source'
            : match[1] === '📤 SINK'
              ? 'sink'
              : match[1] === '🛡️ SANITIZER'
                ? 'sanitizer'
                : 'flow';
        items.push({kind, text: match[2]!});
        j++;
      }

      blocks.push({items, type: 'dataFlow'});
      i = j;
      continue;
    }

    // ── Unordered list ─────────────────────────────────────────────────────
    if (/^(\s*[-*+])\s+/.test(line)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^(\s*[-*+])\s+/.test(lines[j]!)) {
        items.push(lines[j]!.replace(/^\s*[-*+]\s+/, ''));
        j++;
      }

      blocks.push({ items, ordered: false, type: 'list' });
      i = j;
      continue;
    }

    // ── Ordered list ───────────────────────────────────────────────────────
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*\d+[.)]\s+/.test(lines[j]!)) {
        items.push(lines[j]!.replace(/^\s*\d+[.)]\s+/, ''));
        j++;
      }

      blocks.push({ items, ordered: true, type: 'list' });
      i = j;
      continue;
    }

    // ── Blank line ─────────────────────────────────────────────────────────
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Paragraph (collapse contiguous non-blank lines) ─────────────────────
    const paraLines: string[] = [];
    let j = i;
    while (
      j < lines.length &&
      lines[j]!.trim() !== '' &&
      !(lines[j]!).startsWith('```') &&
      !/^#{1,6}\s/.test(lines[j]!) &&
      !/^>\s?/.test(lines[j]!) &&
      !DATA_FLOW_LINE.test(lines[j]!) &&
      !/^\s*[-*+]\s+/.test(lines[j]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[j]!) &&
      !/^(---+|___+|\*\*\*+)\s*$/.test(lines[j]!.trim())
    ) {
      paraLines.push(lines[j]!);
      j++;
    }

    if (paraLines.length > 0) {
      blocks.push({ text: paraLines.join(' '), type: 'paragraph' });
    }

    i = j;
  }

  return blocks;
}

// ── Inline parser ────────────────────────────────────────────────────────────

function parseInline(raw: string, streaming: boolean): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let i = 0;
  let textBuf = '';

  const flushText = () => {
    if (textBuf) {
      segments.push({ text: textBuf, type: 'text' });
      textBuf = '';
    }
  };

  while (i < raw.length) {
    // ── Inline code ────────────────────────────────────────────────────────
    if (raw[i] === '`') {
      const closeIdx = raw.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        flushText();
        segments.push({ text: raw.slice(i + 1, closeIdx), type: 'code' });
        i = closeIdx + 1;
        continue;
      }

      // Unclosed backtick: treat as literal
      textBuf += raw[i];
      i++;
      continue;
    }

    // ── Bold ** or __ ──────────────────────────────────────────────────────
    if ((raw[i] === '*' && raw[i + 1] === '*') || (raw[i] === '_' && raw[i + 1] === '_')) {
      const marker = raw.slice(i, i + 2);
      const closeIdx = raw.indexOf(marker, i + 2);
      if (closeIdx !== -1) {
        flushText();
        segments.push({ text: raw.slice(i + 2, closeIdx), type: 'bold' });
        i = closeIdx + 2;
        continue;
      }

      // In streaming mode, render unclosed bold as plain text
      if (streaming) {
        textBuf += raw.slice(i);
        i = raw.length;
        continue;
      }

      textBuf += marker;
      i += 2;
      continue;
    }

    // ── Italic * or _ (single) ─────────────────────────────────────────────
    if (raw[i] === '*' || raw[i] === '_') {
      const marker = raw[i]!;
      const closeIdx = raw.indexOf(marker, i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        flushText();
        segments.push({ text: raw.slice(i + 1, closeIdx), type: 'italic' });
        i = closeIdx + 1;
        continue;
      }

      // Unclosed italic marker: in streaming mode treat rest as plain text
      if (streaming) {
        textBuf += raw.slice(i);
        i = raw.length;
        continue;
      }

      textBuf += marker;
      i++;
      continue;
    }

    // ── Link [text](url) ──────────────────────────────────────────────────
    if (raw[i] === '[') {
      const closeBracket = raw.indexOf(']', i + 1);
      if (closeBracket !== -1 && raw[closeBracket + 1] === '(') {
        const closeParen = raw.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flushText();
          const linkText = raw.slice(i + 1, closeBracket);
          const url = raw.slice(closeBracket + 2, closeParen);
          segments.push({ text: linkText, type: 'link', url });
          i = closeParen + 1;
          continue;
        }
      }

      // Unclosed link: treat bracket as literal
      textBuf += raw[i];
      i++;
      continue;
    }

    // ── Plain character ────────────────────────────────────────────────────
    textBuf += raw[i];
    i++;
  }

  flushText();
  return segments;
}

// ── Renderers ────────────────────────────────────────────────────────────────

const RenderBlock: React.FC<{ block: Block; streaming: boolean }> = memo(({ block, streaming }) => {
  switch (block.type) {
    case 'blockquote': {
      return <RenderBlockquote block={block} />;
    }

    case 'codeBlock': {
      return <RenderCodeBlock block={block} />;
    }

    case 'dataFlow': {
      return <RenderDataFlow block={block} streaming={streaming} />;
    }

    case 'heading': {
      return <RenderHeading block={block} />;
    }

    case 'hr': {
      return <RenderHR />;
    }

    case 'list': {
      return <RenderList block={block} streaming={streaming} />;
    }

    case 'paragraph': {
      return <RenderParagraph block={block} streaming={streaming} />;
    }

    default: {
      return null;
    }
  }
});
RenderBlock.displayName = 'RenderBlock';

const RenderHeading: React.FC<{ block: HeadingBlock }> = memo(({ block }) => {
  const prefix = '#'.repeat(block.level) + ' ';
  const headingColor =
    block.level <= 2 ? colors.brand : block.level === 3 ? colors.info : colors.bright;
  return (
    <Box marginBottom={1} marginTop={1}>
      <Text bold color={headingColor}>
        {prefix}{block.text}
      </Text>
    </Box>
  );
});
RenderHeading.displayName = 'RenderHeading';

const RenderCodeBlock: React.FC<{ block: CodeBlockBlock }> = memo(({ block }) => (
  <Box
    borderColor={colors.dim}
    borderStyle={'single'}
    flexDirection="column"
    marginBottom={1}
    marginLeft={2}
    marginTop={1}
  >
    {block.language && (
      <Text color={colors.muted} italic>
        {' '}{block.language}
      </Text>
    )}
    {block.code.split('\n').map((line, i) => (
      <Text color={colors.bright} key={i}>
        {' '}{line}
      </Text>
    ))}
  </Box>
));
RenderCodeBlock.displayName = 'RenderCodeBlock';

const DATA_FLOW_STYLE = {
  flow: {color: colors.muted, label: '→'},
  sanitizer: {color: colors.warning, label: 'SANITIZER'},
  sink: {color: colors.error, label: 'SINK'},
  source: {color: colors.info, label: 'SOURCE'},
} as const;

const RenderDataFlow: React.FC<{ block: DataFlowBlock; streaming: boolean }> = memo(({block, streaming}) => (
  <Box
    borderColor={colors.dim}
    borderStyle="single"
    flexDirection="column"
    marginBottom={1}
    marginLeft={2}
    marginTop={1}
  >
    <Text bold color={colors.bright}> Data flow</Text>
    {block.items.map((item, index) => {
      const style = DATA_FLOW_STYLE[item.kind];
      return (
        <Box key={`${item.kind}-${index}`}>
          <Text bold color={style.color}>{` ${style.label.padEnd(10)} `}</Text>
          <InlineText content={item.text} streaming={streaming} />
        </Box>
      );
    })}
  </Box>
));
RenderDataFlow.displayName = 'RenderDataFlow';

const RenderParagraph: React.FC<{ block: ParagraphBlock; streaming: boolean }> = memo(({ block, streaming }) => (
  <Box marginBottom={1}>
    <InlineText content={block.text} streaming={streaming} />
  </Box>
));
RenderParagraph.displayName = 'RenderParagraph';

const RenderList: React.FC<{ block: ListItemBlock; streaming: boolean }> = memo(({ block, streaming }) => (
  <Box flexDirection="column" marginBottom={1} marginLeft={2}>
    {block.items.map((item, i) => (
      <Box key={i}>
        <Text color={colors.muted}>
          {block.ordered ? `${i + 1}. ` : '• '}
        </Text>
        <InlineText content={item} streaming={streaming} />
      </Box>
    ))}
  </Box>
));
RenderList.displayName = 'RenderList';

const RenderBlockquote: React.FC<{ block: BlockquoteBlock }> = memo(({ block }) => (
  <Box marginBottom={1} marginLeft={2}>
    <Text color={colors.dim}>│ </Text>
    <Text color={colors.muted} italic>{block.text}</Text>
  </Box>
));
RenderBlockquote.displayName = 'RenderBlockquote';

const RenderHR: React.FC = memo(() => (
  <Box marginBottom={1} marginTop={1}>
    <Text color={colors.dim}>{'─'.repeat(40)}</Text>
  </Box>
));
RenderHR.displayName = 'RenderHR';

// ── Inline text renderer (parses and renders inline markdown) ────────────────

const InlineText: React.FC<{ content: string; streaming?: boolean }> = memo(
  ({ content, streaming = false }) => {
    const segments = useMemo(() => parseInline(content, streaming), [content, streaming]);
    return (
      <Text>
        {segments.map((seg, i) => {
          switch (seg.type) {
            case 'bold': {
              return <Text bold key={i}>{seg.text}</Text>;
            }

            case 'code': {
              return (
                <Text backgroundColor={colors.dim} color={colors.bright} key={i}>
                  {' '}{seg.text}{' '}
                </Text>
              );
            }

            case 'italic': {
              return <Text color={colors.muted} italic key={i}>{seg.text}</Text>;
            }

            case 'link': {
              return (
                <Text color={colors.brand} key={i} underline>
                  {seg.text} ({seg.url})
                </Text>
              );
            }

            case 'text':
            default: {
              return <Text key={i}>{seg.text}</Text>;
            }
          }
        })}
      </Text>
    );
  },
);
InlineText.displayName = 'InlineText';
