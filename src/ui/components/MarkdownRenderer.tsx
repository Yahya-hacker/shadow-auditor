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

function parseCodeFence(
  lines: string[],
  index: number,
  streaming: boolean,
): {block: Block; nextIndex: number} {
  const line = lines[index]!;
  const language = line.trim().replace(/^```/, '').trim();
  const closingIndex = lines.findIndex(
    (candidate, candidateIndex) =>
      candidateIndex > index && /^```\s*$/.test(candidate.trimStart()),
  );
  const closed = closingIndex !== -1;
  if (!closed && !streaming) {
    return {block: {text: line, type: 'paragraph'}, nextIndex: index + 1};
  }

  const end = closed ? closingIndex : lines.length;
  return {
    block: {code: lines.slice(index + 1, end).join('\n'), language, type: 'codeBlock'},
    nextIndex: closed ? end + 1 : lines.length,
  };
}

function dataFlowKind(label: string): DataFlowBlock['items'][number]['kind'] {
  if (label === '📥 SOURCE') return 'source';
  if (label === '📤 SINK') return 'sink';
  if (label === '🛡️ SANITIZER') return 'sanitizer';
  return 'flow';
}

function parseDataFlow(lines: string[], index: number): {block: DataFlowBlock; nextIndex: number} {
  const items: DataFlowBlock['items'] = [];
  let nextIndex = index;
  while (nextIndex < lines.length) {
    const match = DATA_FLOW_LINE.exec(lines[nextIndex]!);
    if (!match) break;
    items.push({kind: dataFlowKind(match[1]!), text: match[2]!});
    nextIndex++;
  }

  return {block: {items, type: 'dataFlow'}, nextIndex};
}

function collectPrefixedLines({
  index,
  lines,
  pattern,
  replacement,
}: {
  index: number;
  lines: string[];
  pattern: RegExp;
  replacement: RegExp;
}): {items: string[]; nextIndex: number} {
  const items: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length && pattern.test(lines[nextIndex]!)) {
    items.push(lines[nextIndex]!.replace(replacement, ''));
    nextIndex++;
  }

  return {items, nextIndex};
}

function isParagraphLine(line: string): boolean {
  return line.trim() !== '' &&
    !line.startsWith('```') &&
    !/^#{1,6}\s/.test(line) &&
    !/^>\s?/.test(line) &&
    !DATA_FLOW_LINE.test(line) &&
    !/^\s*[-*+]\s+/.test(line) &&
    !/^\s*\d+[.)]\s+/.test(line) &&
    !/^(---+|___+|\*\*\*+)\s*$/.test(line.trim());
}

export function parseMarkdown(raw: string, streaming: boolean): Block[] {
  const blocks: Block[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // ── Fenced code block ──────────────────────────────────────────────────
    if (/^```\w*$/.test(line.trimStart())) {
      const parsed = parseCodeFence(lines, i, streaming);
      blocks.push(parsed.block);
      i = parsed.nextIndex;
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
      const parsed = collectPrefixedLines({index: i, lines, pattern: /^>\s?/, replacement: /^>\s?/});
      blocks.push({text: parsed.items.join(' '), type: 'blockquote'});
      i = parsed.nextIndex;
      continue;
    }

    // ── Security data-flow trace ────────────────────────────────────────────
    if (DATA_FLOW_LINE.test(line)) {
      const parsed = parseDataFlow(lines, i);
      blocks.push(parsed.block);
      i = parsed.nextIndex;
      continue;
    }

    // ── Unordered list ─────────────────────────────────────────────────────
    if (/^(\s*[-*+])\s+/.test(line)) {
      const parsed = collectPrefixedLines({
        index: i,
        lines,
        pattern: /^(\s*[-*+])\s+/,
        replacement: /^\s*[-*+]\s+/,
      });
      blocks.push({items: parsed.items, ordered: false, type: 'list'});
      i = parsed.nextIndex;
      continue;
    }

    // ── Ordered list ───────────────────────────────────────────────────────
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const parsed = collectPrefixedLines({
        index: i,
        lines,
        pattern: /^\s*\d+[.)]\s+/,
        replacement: /^\s*\d+[.)]\s+/,
      });
      blocks.push({items: parsed.items, ordered: true, type: 'list'});
      i = parsed.nextIndex;
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
    while (j < lines.length && isParagraphLine(lines[j]!)) {
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

export function parseInline(raw: string, streaming: boolean): InlineSegment[] {
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

    // ── Bold-italic *** or ___ (triple) ───────────────────────────────────
    // Must be checked BEFORE bold ** and italic *: for `***x***` the bold
    // branch would otherwise match the first two stars as an opener and the
    // first two stars of the closer, leaving a dangling trailing star and
    // mis-rendering `*x*` as the bold body.
    if ((raw[i] === '*' && raw[i + 1] === '*' && raw[i + 2] === '*') ||
        (raw[i] === '_' && raw[i + 1] === '_' && raw[i + 2] === '_')) {
      const marker = raw.slice(i, i + 3);
      const closeIdx = raw.indexOf(marker, i + 3);
      if (closeIdx !== -1) {
        flushText();
        segments.push({ text: raw.slice(i + 3, closeIdx), type: 'bold' });
        i = closeIdx + 3;
        continue;
      }
      // Unclosed triple marker: fall through and let the single/bold branches
      // handle it as literal text.
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
        // Scan for the matching close paren. depth starts at 1 to account for
        // the link's own opening paren, so a balanced paren *inside* the URL
        // (e.g. `http://host/a(b)`) still lands us back at depth 1 instead of
        // being mistaken for the link's closing paren.
        let depth = 1;
        let closeParen = -1;
        for (let j = closeBracket + 2; j < raw.length; j++) {
          if (raw[j] === '(') depth++;
          else if (raw[j] === ')') {
            depth--;
            if (depth === 0) { closeParen = j; break; }
          }
        }

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
