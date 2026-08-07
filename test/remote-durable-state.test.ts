import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionSnapshot } from '../src/protocol/generated.js';

import {
  ActiveSessionStore,
  CursorStore,
  ExecutionLedger,
} from '../src/core/remote/durable-state.js';
import { ProtocolError } from '../src/core/remote/protocol-error.js';

function sessionSnapshot(): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    cursor: 3,
    lastEventHash: `sha256:${'a'.repeat(64)}`,
    negotiatedCapabilities: {
      eventRetentionSeconds: 3600,
      features: [
        'digest-bound-approvals',
        'durable-events',
        'event-hash-chain',
        'local-tool-execution',
        'resumable-sessions',
        'sse',
      ],
      heartbeatIntervalMs: 5000,
      maxClientPayloadBytes: 524_288,
      maxServerEventBytes: 1_048_576,
      protocolVersion: '1.0',
      tools: [],
    },
    pendingToolProposalIds: [],
    protocolVersion: '1.0',
    scan: {
      exclusions: ['.git'],
      mode: 'audit',
      objective: 'Audit the repository',
      scope: ['.'],
    },
    sessionId: randomUUID(),
    status: 'paused',
    updatedAt: now,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      storageBytes: 3,
      toolExecutionMilliseconds: 4,
    },
  };
}

describe('remote durable state', () => {
  let targetPath: string;

  beforeEach(async () => {
    targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-auditor-durable-'));
  });

  afterEach(async () => {
    await fs.rm(targetPath, { force: true, recursive: true });
  });

  it('atomically persists and restores the event cursor', async () => {
    const store = new CursorStore(targetPath);
    expect(await store.load('session_1')).to.include({ eventHash: null, sequence: 0 });
    await store.persist({
      eventHash: `sha256:${'a'.repeat(64)}`,
      sequence: 7,
      sessionId: 'session_1',
      updatedAt: new Date().toISOString(),
    });
    expect(await new CursorStore(targetPath).load('session_1')).to.include({
      eventHash: `sha256:${'a'.repeat(64)}`,
      sequence: 7,
    });
  });

  it('atomically persists and restores the active session for process restart', async () => {
    const snapshot = sessionSnapshot();
    const store = new ActiveSessionStore(targetPath, 'https://backend.example.test');
    await store.persist(snapshot);

    expect(await new ActiveSessionStore(
      targetPath,
      'https://backend.example.test',
    ).load()).to.deep.equal(snapshot);
    expect(await new ActiveSessionStore(
      targetPath,
      'https://other-backend.example.test',
    ).load()).to.equal(null);

    await store.clear(snapshot.sessionId);
    expect(await store.load()).to.equal(null);
  });

  it('restores append-only tool lifecycle entries without losing replay metadata', async () => {
    const ledger = await ExecutionLedger.open(targetPath, 'session_1');
    await ledger.append('proposal-1', 'decision', { decision: 'approve' });
    await ledger.append('proposal-1', 'grant', { nonce: 'nonce-1' });
    await ledger.append('proposal-1', 'execution_started', { startedAt: new Date().toISOString() });
    await ledger.append('proposal-1', 'result', { status: 'succeeded' });

    const restored = await ExecutionLedger.open(targetPath, 'session_1');
    expect(restored.hasGrantNonce('nonce-1')).to.equal(true);
    expect(restored.findLatest('proposal-1', 'decision')?.data.decision).to.equal('approve');
    expect(restored.findLatest('proposal-1', 'result')?.data.status).to.equal('succeeded');
  });

  it('fails closed when a cursor or execution ledger is corrupted', async () => {
    const cursorDirectory = path.join(targetPath, '.shadow-auditor', 'remote-sessions');
    await fs.mkdir(cursorDirectory, { recursive: true });
    await fs.writeFile(path.join(cursorDirectory, 'session_1.cursor.json'), '{"sequence":"bad"}\n');
    let cursorFailure: unknown;
    try {
      await new CursorStore(targetPath).load('session_1');
    } catch (error) {
      cursorFailure = error;
    }

    expect(cursorFailure).to.be.instanceOf(ProtocolError);

    const activeStore = new ActiveSessionStore(targetPath, 'https://backend.example.test');
    await activeStore.persist(sessionSnapshot());
    const activeFile = (await fs.readdir(cursorDirectory))
      .find((file) => file.endsWith('.active-session.json'));
    await fs.writeFile(path.join(cursorDirectory, activeFile ?? ''), '{"status":"running"}\n');
    let activeFailure: unknown;
    try {
      await activeStore.load();
    } catch (error) {
      activeFailure = error;
    }

    expect(activeFailure).to.be.instanceOf(ProtocolError);

    const ledger = await ExecutionLedger.open(targetPath, 'session_2');
    await ledger.append('proposal-1', 'grant', { nonce: 'nonce-1' });
    const ledgerPath = path.join(targetPath, '.shadow-auditor', 'execution-ledgers', 'session_2.jsonl');
    const serialized = await fs.readFile(ledgerPath, 'utf8');
    await fs.writeFile(ledgerPath, serialized.replace('"nonce-1"', '"nonce-2"'));
    let ledgerFailure: unknown;
    try {
      await ExecutionLedger.open(targetPath, 'session_2');
    } catch (error) {
      ledgerFailure = error;
    }

    expect(ledgerFailure).to.be.instanceOf(ProtocolError);
  });
});
