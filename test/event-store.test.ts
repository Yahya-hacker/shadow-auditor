import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../src/core/memory/event-store.js';

describe('EventStore durability', () => {
  it('removes an interrupted tail before appending new events', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'event-store-'));
    try {
      const first = await EventStore.create({ runId: 'test-run', storagePath });
      expect((await first.append('mission_started', { sequence: 1 })).ok).to.equal(true);
      await fs.appendFile(path.join(storagePath, 'events.jsonl'), '{"eventId":"partial');

      const reopened = await EventStore.create({ runId: 'test-run', storagePath });
      expect((await reopened.append('mission_completed', { sequence: 2 })).ok).to.equal(true);
      const events = await reopened.read();

      expect(events.ok).to.equal(true);
      if (!events.ok) throw new Error(events.error);
      expect(events.value.map((event) => event.payload.sequence)).to.deep.equal([1, 2]);
    } finally {
      await fs.rm(storagePath, { force: true, recursive: true });
    }
  });

  it('continues accepting events after one append fails', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'event-store-'));
    const store = await EventStore.create({ runId: 'test-run', storagePath });
    await fs.rm(storagePath, { force: true, recursive: true });
    const failed = await store.append('mission_started', { sequence: 1 });
    expect(failed.ok).to.equal(false);
    await fs.mkdir(storagePath, { recursive: true });
    expect((await store.append('mission_completed', { sequence: 2 })).ok).to.equal(true);
    const events = await store.read();
    expect(events.ok).to.equal(true);
    if (!events.ok) throw new Error(events.error);
    expect(events.value.map((event) => event.payload.sequence)).to.deep.equal([2]);
    await fs.rm(storagePath, { force: true, recursive: true });
  });

  it('streams large logs while preserving filters, limits, and counts', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'event-store-large-'));
    try {
      const store = await EventStore.create({runId: 'large-run', storagePath});
      for (let sequence = 0; sequence < 2000; sequence += 1) {
        const eventType = sequence % 2 === 0 ? 'tool_call' : 'tool_result';
        expect((await store.append(eventType, {sequence})).ok).to.equal(true);
      }

      expect(await store.count()).to.equal(2000);
      const filtered = await store.read({eventTypes: ['tool_result'], limit: 7});
      expect(filtered.ok).to.equal(true);
      if (!filtered.ok) throw new Error(filtered.error);
      expect(filtered.value).to.have.length(7);
      expect(filtered.value.every(({eventType}) => eventType === 'tool_result')).to.equal(true);
    } finally {
      await fs.rm(storagePath, {force: true, recursive: true});
    }
  });
});
