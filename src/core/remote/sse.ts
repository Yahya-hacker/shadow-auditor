import type { EventEnvelope } from '../../protocol/generated.js';

import { validateProtocolDto } from '../../protocol/validate.js';
import { problem, ProtocolError } from './protocol-error.js';

export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
  maxEventBytes: number,
): AsyncGenerator<EventEnvelope> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let eventBytes = 0;
  let data: null | string = null;

  const finishEvent = (): EventEnvelope | null => {
    if (data === null) {
      eventBytes = 0;
      return null;
    }

    const serialized = data;
    data = null;
    eventBytes = 0;
    try {
      return validateProtocolDto<EventEnvelope>('event-envelope.schema.json', JSON.parse(serialized));
    } catch (error) {
      throw new ProtocolError(
        problem({
          code: 'INVALID_SSE_EVENT',
          detail: 'SSE data is not a valid EventEnvelope',
          status: 400,
          title: 'Malformed event stream',
        }),
        { cause: error },
      );
    }
  };

  const processLine = (rawLine: string): EventEnvelope | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return finishEvent();
    if (line.startsWith(':')) return null;
    if (line.startsWith('data:')) {
      if (data !== null) {
        throw new ProtocolError(problem({
          code: 'MULTILINE_SSE_DATA',
          detail: 'Each SSE event must contain exactly one compact JSON data field',
          status: 400,
          title: 'Unsupported SSE framing',
        }));
      }

      data = line.slice(5).trimStart();
      return null;
    }

    throw new ProtocolError(problem({
      code: 'UNSUPPORTED_SSE_FIELD',
      detail: 'SSE events may contain only comments and one compact JSON data field',
      status: 400,
      title: 'Unsupported SSE framing',
    }));
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        eventBytes += Buffer.byteLength(rawLine) + 1;
        if (eventBytes > maxEventBytes) {
          throw new ProtocolError(problem({
            code: 'SSE_EVENT_TOO_LARGE',
            detail: `SSE event exceeds ${maxEventBytes} bytes`,
            status: 413,
            title: 'Event stream payload exceeds negotiated limit',
          }));
        }

        const envelope = processLine(rawLine);
        if (envelope) yield envelope;
      }

      if (Buffer.byteLength(buffer) + eventBytes > maxEventBytes) {
        throw new ProtocolError(problem({
          code: 'SSE_EVENT_TOO_LARGE',
          detail: `SSE event exceeds ${maxEventBytes} bytes`,
          status: 413,
          title: 'Event stream payload exceeds negotiated limit',
        }));
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      eventBytes += Buffer.byteLength(buffer);
      if (eventBytes > maxEventBytes) {
        throw new ProtocolError(problem({
          code: 'SSE_EVENT_TOO_LARGE',
          detail: `SSE event exceeds ${maxEventBytes} bytes`,
          status: 413,
          title: 'Event stream payload exceeds negotiated limit',
        }));
      }

      const envelope = processLine(buffer);
      if (envelope) yield envelope;
    }

    const envelope = finishEvent();
    if (envelope) yield envelope;
  } finally {
    reader.releaseLock();
  }
}
