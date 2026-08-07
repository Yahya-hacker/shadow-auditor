import { expect } from 'chai';

import type { EventEnvelope } from '../src/protocol/generated.js';

import { validateEventEnvelope } from '../src/core/remote/crypto.js';
import { ProtocolError } from '../src/core/remote/protocol-error.js';
import { parseEventStream } from '../src/core/remote/sse.js';
import { toJsonValue } from '../src/core/tools/local-tool.js';
import { validateProtocolDto } from '../src/protocol/validate.js';
import { createEventSigner, createSignedEvent, streamFromText } from './remote-fixtures.js';

async function collect(stream: AsyncGenerator<EventEnvelope>): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected operation to fail');
}

describe('remote protocol runtime', () => {
  it('rejects unknown fields in runtime DTO validation', () => {
    expect(() => validateProtocolDto('health-response.schema.json', {
      extra: true,
      protocolVersion: '1.0',
      serverTime: new Date().toISOString(),
      status: 'ok',
    })).to.throw(ProtocolError);
  });

  it('accepts only strict JSON values', () => {
    expect(toJsonValue({ nested: [1, true, null, 'ok'] })).to.deep.equal({
      nested: [1, true, null, 'ok'],
    });
    expect(() => toJsonValue({ callback() {} })).to.throw('Unsupported non-JSON value');
    expect(() => toJsonValue(new Error('not serializable'))).to.throw('Class instances');
    expect(() => toJsonValue(Number.POSITIVE_INFINITY)).to.throw('finite');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toJsonValue(circular)).to.throw('Circular');
  });

  it('parses one compact EventEnvelope per bounded SSE event', async () => {
    const event = createSignedEvent({ signer: createEventSigner() });
    const serialized = `: heartbeat\n\ndata: ${JSON.stringify(event)}\n\n`;
    expect(await collect(parseEventStream(streamFromText(serialized), 16 * 1024))).to.deep.equal([event]);
  });

  it('fails closed on multiline, unsupported, and oversized SSE framing', async () => {
    const event = createSignedEvent({ signer: createEventSigner() });
    const compact = JSON.stringify(event);
    for (const serialized of [
      `data: ${compact}\ndata: ${compact}`,
      `event: heartbeat\ndata: ${compact}\n\n`,
    ]) {
      expect(await captureFailure(async () => collect(
        parseEventStream(streamFromText(serialized), 32 * 1024),
      ))).to.be.instanceOf(ProtocolError);
    }

    const failure = await captureFailure(async () => collect(
      parseEventStream(streamFromText(`data: ${compact}\n\n`), 32),
    ));
    expect(failure).to.be.instanceOf(ProtocolError);
    expect((failure as ProtocolError).problem.code).to.equal('SSE_EVENT_TOO_LARGE');
  });

  it('validates signed hash-chained events and rejects tampering', () => {
    const signer = createEventSigner();
    const first = createSignedEvent({ payload: { message: 'one' }, signer });
    const next = validateEventEnvelope(first, { eventHash: null, sequence: 0 }, [signer.publicKey], 4096);
    expect(next).to.deep.equal({ eventHash: first.eventHash, sequence: 1 });

    const second = createSignedEvent({
      payload: { message: 'two' },
      previousEventHash: first.eventHash,
      sequence: 2,
      sessionId: first.sessionId,
      signer,
    });
    expect(validateEventEnvelope(second, next, [signer.publicKey], 4096).sequence).to.equal(2);
    expect(() => validateEventEnvelope(
      { ...second, payload: { message: 'tampered' } },
      next,
      [signer.publicKey],
      4096,
    )).to.throw(ProtocolError);
  });
});
