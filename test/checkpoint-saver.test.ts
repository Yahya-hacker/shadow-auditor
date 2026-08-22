import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PersistentCheckpointSaver } from '../src/core/orchestrator/checkpoint-saver.js';

function checkpoint(id: string, ts: string) {
  return {
    channel_values: { marker: id },
    channel_versions: {},
    id,
    pending_sends: [],
    ts,
    v: 1 as const,
    versions_seen: {},
  };
}

const metadata = { parents: {}, source: 'loop' as const, step: 1 };

describe('PersistentCheckpointSaver', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-checkpoint-'));
  });

  afterEach(async () => {
    await fs.rm(storagePath, { force: true, recursive: true });
  });

  it('restores the newest checkpoint when only a thread ID is supplied', async () => {
    const first = new PersistentCheckpointSaver({ storagePath });
    await first.initialize();
    const config = { configurable: { thread_id: 'resume-thread' } };

    await first.put(config, checkpoint('older', '2026-01-01T00:00:00.000Z'), metadata, {});
    await first.put(config, checkpoint('newest', '2026-01-02T00:00:00.000Z'), metadata, {});

    const restarted = new PersistentCheckpointSaver({ storagePath });
    await restarted.initialize();
    const tuple = await restarted.getTuple(config);

    expect(tuple?.checkpoint.id).to.equal('newest');
    expect(tuple?.config.configurable?.checkpoint_id).to.equal('newest');
  });

  it('recovers a newer durable checkpoint when the latest index is stale', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = { configurable: { thread_id: 'crash-window' } };
    await saver.put(config, checkpoint('older', '2026-01-01T00:00:00.000Z'), metadata, {});
    await saver.put(config, checkpoint('newest', '2026-01-02T00:00:00.000Z'), metadata, {});

    const threadKey = Buffer.from('crash-window').toString('base64url');
    const latestPath = path.join(storagePath, 'langgraph-checkpoints', threadKey, 'latest.json');
    await fs.writeFile(latestPath, JSON.stringify({
      checkpointId: 'older',
      timestamp: '2026-01-01T00:00:00.000Z',
    }));

    const restarted = new PersistentCheckpointSaver({ storagePath });
    await restarted.initialize();
    expect((await restarted.getTuple(config))?.checkpoint.id).to.equal('newest');
  });

  it('preserves LangChain message classes across a process-style restart', async () => {
    const first = new PersistentCheckpointSaver({ storagePath });
    await first.initialize();
    const config = { configurable: { thread_id: 'typed-messages' } };
    const typedCheckpoint = {
      ...checkpoint('messages', '2026-01-01T00:00:00.000Z'),
      channel_values: {
        messages: [
          new HumanMessage('audit this target'),
          new AIMessage('analysis complete'),
        ],
      },
    };
    await first.put(config, typedCheckpoint, metadata, {});

    const restarted = new PersistentCheckpointSaver({ storagePath });
    await restarted.initialize();
    const messages = (await restarted.getTuple(config))?.checkpoint.channel_values.messages;

    expect(messages).to.be.an('array').with.length(2);
    if (!Array.isArray(messages)) throw new Error('Expected restored messages to be an array.');
    expect(messages[0]).to.be.instanceOf(HumanMessage);
    expect(messages[1]).to.be.instanceOf(AIMessage);
  });

  it('restores an explicitly requested checkpoint', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const threadConfig = { configurable: { thread_id: 'resume-thread' } };
    await saver.put(threadConfig, checkpoint('older', '2026-01-01T00:00:00.000Z'), metadata, {});
    await saver.put(threadConfig, checkpoint('newest', '2026-01-02T00:00:00.000Z'), metadata, {});

    const tuple = await saver.getTuple({
      configurable: { checkpoint_id: 'older', thread_id: 'resume-thread' },
    });

    expect(tuple?.checkpoint.id).to.equal('older');
  });

  it('persists the incoming checkpoint as the parent of the next checkpoint', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const threadConfig = { configurable: { thread_id: 'ancestry-thread' } };
    const parentConfig = await saver.put(
      threadConfig,
      checkpoint('parent', '2026-01-01T00:00:00.000Z'),
      metadata,
      {},
    );
    await saver.put(
      parentConfig,
      checkpoint('child', '2026-01-02T00:00:00.000Z'),
      metadata,
      {},
    );

    const child = await saver.getTuple({
      configurable: { checkpoint_id: 'child', thread_id: 'ancestry-thread' },
    });
    expect(child?.parentConfig?.configurable?.checkpoint_id).to.equal('parent');
  });

  it('persists task-aware pending writes without losing concurrent updates', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = { configurable: { thread_id: 'writes-thread' } };
    const storedConfig = await saver.put(
      config,
      checkpoint('writes', '2026-01-01T00:00:00.000Z'),
      metadata,
      {},
    );

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        saver.putWrites(storedConfig, [['channel', index]], `task-${index}`)),
    );
    const tuple = await saver.getTuple(storedConfig);

    expect(tuple?.pendingWrites).to.have.length(20);
    expect(tuple?.pendingWrites?.map(([taskId]) => taskId)).to.have.members(
      Array.from({ length: 20 }, (_, index) => `task-${index}`),
    );
  });

  it('stages pending writes that arrive before their checkpoint', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = {
      configurable: { checkpoint_id: 'delayed-checkpoint', thread_id: 'delayed-writes' },
    };

    await saver.putWrites(config, [['channel', 'before-put']], 'early-task');
    await saver.put(
      { configurable: { thread_id: 'delayed-writes' } },
      checkpoint('delayed-checkpoint', '2026-01-01T00:00:00.000Z'),
      metadata,
      {},
    );

    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites).to.deep.equal([['early-task', 'channel', 'before-put']]);
  });

  it('recovers staged writes after a process-style restart', async () => {
    const first = new PersistentCheckpointSaver({ storagePath });
    await first.initialize();
    const config = {
      configurable: { checkpoint_id: 'restarted-checkpoint', thread_id: 'restarted-writes' },
    };
    await first.putWrites(config, [['channel', 'durable-before-put']], 'early-task');

    const restarted = new PersistentCheckpointSaver({ storagePath });
    await restarted.initialize();
    await restarted.put(
      { configurable: { thread_id: 'restarted-writes' } },
      checkpoint('restarted-checkpoint', '2026-01-01T00:00:00.000Z'),
      metadata,
      {},
    );

    const tuple = await restarted.getTuple(config);
    expect(tuple?.pendingWrites).to.deep.equal([['early-task', 'channel', 'durable-before-put']]);
  });

  it('retains only the configured number of newest checkpoints', async () => {
    const saver = new PersistentCheckpointSaver({
      maxCheckpointsPerThread: 2,
      storagePath,
    });
    await saver.initialize();
    const config = { configurable: { thread_id: 'bounded-thread' } };

    await saver.put(config, checkpoint('one', '2026-01-01T00:00:00.000Z'), metadata, {});
    await saver.put(config, checkpoint('two', '2026-01-02T00:00:00.000Z'), metadata, {});
    await saver.put(config, checkpoint('three', '2026-01-03T00:00:00.000Z'), metadata, {});
    await saver.prune('bounded-thread');

    const ids: string[] = [];
    for await (const tuple of saver.list(config)) ids.push(tuple.checkpoint.id);

    expect(ids).to.deep.equal(['three', 'two']);
    expect(await saver.getTuple({
      configurable: { checkpoint_id: 'one', thread_id: 'bounded-thread' },
    })).to.equal(undefined);
  });

  it('fails closed instead of silently skipping a corrupt checkpoint', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = { configurable: { thread_id: 'corrupt-thread' } };
    await saver.put(config, checkpoint('broken', '2026-01-01T00:00:00.000Z'), metadata, {});
    const threadKey = Buffer.from('corrupt-thread').toString('base64url');
    await fs.writeFile(
      path.join(storagePath, 'langgraph-checkpoints', threadKey, 'broken.json'),
      '{invalid json',
    );

    let error: unknown;
    try {
      for await (const _tuple of saver.list(config)) {
        // Iteration must surface corruption.
      }
    } catch (error_) {
      error = error_;
    }

    expect((error as Error).message).to.include('Failed to read checkpoint');
  });

  it('ignores stray staged-write files when listing checkpoints', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = { configurable: { thread_id: 'stray-pending' } };
    await saver.put(config, checkpoint('real', '2026-01-01T00:00:00.000Z'), metadata, {});

    // Simulate a crash mid-staging: a `.pending.json` file left behind.
    const threadKey = Buffer.from('stray-pending').toString('base64url');
    const threadDir = path.join(storagePath, 'langgraph-checkpoints', threadKey);
    await fs.writeFile(
      path.join(threadDir, `${Buffer.from('ghost').toString('base64url')}.pending.json`),
      'not a checkpoint',
    );

    const ids: string[] = [];
    for await (const tuple of saver.list(config)) ids.push(tuple.checkpoint.id);

    expect(ids).to.deep.equal(['real']);
  });

  it('skips a checkpoint removed concurrently during listing', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = { configurable: { thread_id: 'race-thread' } };
    await saver.put(config, checkpoint('a', '2026-01-01T00:00:00.000Z'), metadata, {});
    await saver.put(config, checkpoint('b', '2026-01-02T00:00:00.000Z'), metadata, {});

    const threadKey = Buffer.from('race-thread').toString('base64url');
    const threadDir = path.join(storagePath, 'langgraph-checkpoints', threadKey);
    const aPath = path.join(threadDir, `${Buffer.from('a').toString('base64url')}.json`);
    await fs.rm(aPath, { force: true });

    const ids: string[] = [];
    for await (const tuple of saver.list(config)) ids.push(tuple.checkpoint.id);

    expect(ids).to.deep.equal(['b']);
  });

  it('rejects a repository-modified checkpoint with valid JSON', async () => {
    const keyPath = path.join(storagePath, 'external-trust', 'checkpoint.key');
    const saver = new PersistentCheckpointSaver({integrityKeyPath: keyPath, storagePath});
    await saver.initialize();
    const config = {configurable: {thread_id: 'tampered-thread'}};
    await saver.put(config, checkpoint('tampered', '2026-01-01T00:00:00.000Z'), metadata, {});
    const threadKey = Buffer.from('tampered-thread').toString('base64url');
    const checkpointPath = path.join(
      storagePath,
      'langgraph-checkpoints',
      threadKey,
      `${Buffer.from('tampered').toString('base64url')}.json`,
    );
    const document = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as {
      data: string;
    };
    document.data = Buffer.from('attacker-controlled state').toString('base64');
    await fs.writeFile(checkpointPath, JSON.stringify(document));

    const restarted = new PersistentCheckpointSaver({integrityKeyPath: keyPath, storagePath});
    await restarted.initialize();
    let error: unknown;
    try {
      await restarted.getTuple({
        configurable: {checkpoint_id: 'tampered', thread_id: 'tampered-thread'},
      });
    } catch (error_) {
      error = error_;
    }

    expect((error as Error).message).to.include('integrity verification failed');
  });

  it('does not allow thread or checkpoint identifiers to escape storage', async () => {
    const saver = new PersistentCheckpointSaver({ storagePath });
    await saver.initialize();
    const config = { configurable: { thread_id: '../../outside' } };
    const storedConfig = await saver.put(
      config,
      checkpoint('../checkpoint', '2026-01-01T00:00:00.000Z'),
      metadata,
      {},
    );

    expect((await saver.getTuple(storedConfig))?.checkpoint.id).to.equal('../checkpoint');
    expect(await fs.readdir(path.dirname(storagePath))).not.to.include('outside');
  });
});
