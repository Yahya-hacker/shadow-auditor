import * as crypto from 'node:crypto';
import * as path from 'node:path';

import type {CodeChunk} from './types.js';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function splitChunk(chunk: CodeChunk, maxChunkChars: number): CodeChunk[] {
  if (chunk.rawContent.length <= maxChunkChars) return [chunk];

  const windows: CodeChunk[] = [];
  const overlapChars = Math.min(400, Math.max(1, Math.floor(maxChunkChars * 0.1)));
  let cursor = 0;
  let startLine = chunk.startLine;
  let windowIndex = 0;

  while (cursor < chunk.rawContent.length) {
    let end = Math.min(chunk.rawContent.length, cursor + maxChunkChars);
    if (end < chunk.rawContent.length) {
      const minimumBreak = cursor + Math.floor(maxChunkChars * 0.6);
      const lineBreak = chunk.rawContent.lastIndexOf('\n', end);
      if (lineBreak >= minimumBreak) end = lineBreak + 1;
    }

    const rawContent = chunk.rawContent.slice(cursor, end);
    const newlineCount = (rawContent.match(/\n/g) ?? []).length;
    const endLine = Math.min(chunk.endLine, startLine + newlineCount);
    windows.push({
      ...chunk,
      contentHash: hash(rawContent),
      endLine,
      id: `chunk_${hash(`${chunk.id}:window:${windowIndex}:${cursor}:${end}`)}`,
      rawContent,
      startLine,
      symbol: `${chunk.symbol} [part ${windowIndex + 1}]`,
    });

    if (end >= chunk.rawContent.length) break;
    let nextCursor = Math.max(cursor + 1, end - overlapChars);
    const nextLineBreak = chunk.rawContent.indexOf('\n', nextCursor);
    if (nextLineBreak !== -1 && nextLineBreak < end) nextCursor = nextLineBreak + 1;
    startLine += (chunk.rawContent.slice(cursor, nextCursor).match(/\n/g) ?? []).length;
    cursor = nextCursor;
    windowIndex++;
  }

  return windows;
}

export function finalizeChunks(
  chunks: CodeChunk[],
  sourceCode: string,
  options: {
    filePath: string;
    language: string;
    maxChunkChars: number;
  },
): CodeChunk[] {
  const {filePath, language, maxChunkChars} = options;
  const lines = sourceCode.split('\n');
  const covered = new Uint8Array(lines.length);
  for (const chunk of chunks) {
    const start = Math.max(0, chunk.startLine - 1);
    const end = Math.min(lines.length - 1, chunk.endLine - 1);
    for (let line = start; line <= end; line++) covered[line] = 1;
  }

  let rangeStart: number | undefined;
  for (let index = 0; index <= lines.length; index++) {
    const uncoveredMeaningful = index < lines.length && covered[index] === 0 && lines[index]!.trim() !== '';
    if (uncoveredMeaningful && rangeStart === undefined) rangeStart = index;
    if ((!uncoveredMeaningful || index === lines.length) && rangeStart !== undefined) {
      let rangeEnd = index - 1;
      while (rangeEnd + 1 < lines.length && covered[rangeEnd + 1] === 0 && lines[rangeEnd + 1]!.trim() === '') {
        rangeEnd++;
      }

      const rawContent = lines.slice(rangeStart, rangeEnd + 1).join('\n');
      chunks.push({
        contentHash: hash(rawContent),
        endLine: rangeEnd + 1,
        filePath,
        id: `chunk_${hash(`${filePath}:residual:${rangeStart + 1}:${rangeEnd + 1}`)}`,
        language,
        parentContext: '',
        rawContent,
        startLine: rangeStart + 1,
        structuralType: 'file_fragment',
        symbol: path.basename(filePath),
      });
      rangeStart = undefined;
    }
  }

  return chunks.flatMap((chunk) => splitChunk(chunk, maxChunkChars));
}
