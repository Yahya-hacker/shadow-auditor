import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CapabilityNegotiationResponse,
  ClientCapabilities,
  EventEnvelope,
  NegotiatedCapabilities,
  SessionControlResponse,
  SessionSnapshot,
} from '../src/protocol/generated.js';
import type { DeviceCredentialVault } from '../src/utils/keychain.js';

import { RemoteApiClient } from '../src/core/remote/api-client.js';
import {
  ActiveSessionStore,
  CursorStore,
} from '../src/core/remote/durable-state.js';
import { RemoteAgentSession } from '../src/core/remote/runtime.js';
import {
  createDeviceCredentials,
  createEventSigner,
  createSignedEvent,
  createTestVault,
} from './remote-fixtures.js';

class RestartApiClient extends RemoteApiClient {
  event: EventEnvelope | null = null;
  negotiated: NegotiatedCapabilities | null = null;
  resumedFrom: null | {
    cursor: number;
    lastEventHash: null | string;
    sessionId: string;
  } = null;

  constructor(
    vault: DeviceCredentialVault,
    private readonly signingKey: ReturnType<typeof createEventSigner>,
  ) {
    super({
      backendUrl: 'https://backend.example.test',
      credentialAccount: 'test',
      async fetchImplementation() {
        throw new Error('Unexpected network request');
      },
      vault,
    });
  }

  override async capabilities(client: ClientCapabilities): Promise<CapabilityNegotiationResponse> {
    this.negotiated = {
      eventRetentionSeconds: 3600,
      features: [...client.features],
      heartbeatIntervalMs: 5000,
      maxClientPayloadBytes: client.maxOutboundPayloadBytes,
      maxServerEventBytes: client.maxInboundEventBytes,
      protocolVersion: '1.0',
      tools: [...client.tools],
    };
    return {
      negotiated: this.negotiated,
      negotiatedAt: new Date().toISOString(),
      protocolVersion: '1.0',
      server: {
        eventRetentionSeconds: 3600,
        features: [...client.features],
        heartbeatIntervalMs: 5000,
        maxInboundPayloadBytes: client.maxOutboundPayloadBytes,
        maxOutboundEventBytes: client.maxInboundEventBytes,
        protocolVersions: ['1.0'],
        signingKeys: [this.signingKey.publicKey],
      },
    };
  }

  override async resume(
    sessionId: string,
    cursor: number,
    lastEventHash: null | string,
  ): Promise<SessionControlResponse> {
    this.resumedFrom = { cursor, lastEventHash, sessionId };
    return {
      cursor,
      effectiveAt: new Date().toISOString(),
      protocolVersion: '1.0',
      sessionId,
      status: 'running',
    };
  }

  override async streamEvents(
    _sessionId: string,
    _cursor: number,
    _maxEventBytes: number,
    _signal?: AbortSignal,
  ): Promise<AsyncGenerator<EventEnvelope>> {
    const event = this.event;
    return (async function* (): AsyncGenerator<EventEnvelope> {
      if (event) yield event;
    })();
  }
}

function snapshot(
  negotiatedCapabilities: NegotiatedCapabilities,
  sessionId: string,
  eventHash: string,
): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    cursor: 3,
    lastEventHash: eventHash,
    negotiatedCapabilities,
    pendingToolProposalIds: [],
    protocolVersion: '1.0',
    scan: {
      exclusions: [],
      mode: 'audit',
      objective: 'Audit the repository',
      scope: ['.'],
    },
    sessionId,
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

describe('RemoteAgentSession process restart', () => {
  let targetPath: string;

  beforeEach(async () => {
    targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-runtime-restart-'));
  });

  afterEach(async () => {
    await fs.rm(targetPath, { force: true, recursive: true });
  });

  it('restores an active session, resumes from its durable chain, and clears terminal state', async () => {
    const signingKey = createEventSigner();
    const { vault } = await createTestVault(
      createDeviceCredentials([signingKey.publicKey]),
    );
    const api = new RestartApiClient(vault, signingKey);
    const options = {
      apiClient: api,
      config: {
        auditMode: 'audit' as const,
        backendUrl: 'https://backend.example.test',
        credentialAccount: 'test',
        deviceName: 'test-device',
      },
      repositoryMap: 'empty repository',
      targetPath,
    };
    const initialRuntime = await RemoteAgentSession.create(options);
    expect(initialRuntime.getActiveSessionId()).to.equal(null);
    const negotiated = api.negotiated;
    if (!negotiated) throw new Error('Test capability negotiation did not complete');
    await initialRuntime.shutdown();

    const sessionId = randomUUID();
    const eventHash = `sha256:${'a'.repeat(64)}`;
    const persisted = snapshot(negotiated, sessionId, eventHash);
    await new ActiveSessionStore(targetPath, options.config.backendUrl).persist(persisted);
    await new CursorStore(targetPath).persist({
      eventHash,
      sequence: persisted.cursor,
      sessionId,
      updatedAt: new Date().toISOString(),
    });
    api.event = createSignedEvent({
      eventType: 'session.completed',
      payload: {},
      previousEventHash: eventHash,
      sequence: 4,
      sessionId,
      signer: signingKey,
    });

    const restoredRuntime = await RemoteAgentSession.create(options);
    expect(restoredRuntime.getActiveSessionId()).to.equal(sessionId);
    const activities = [];
    for await (const activity of restoredRuntime.resume()) activities.push(activity);
    expect(api.resumedFrom).to.deep.equal({
      cursor: 3,
      lastEventHash: eventHash,
      sessionId,
    });
    expect(activities).to.deep.include({
      content: 'Remote session completed',
      type: 'status',
    });
    expect(
      await new ActiveSessionStore(targetPath, options.config.backendUrl).load(),
    ).to.equal(null);
    await restoredRuntime.shutdown();

    const finalRuntime = await RemoteAgentSession.create(options);
    expect(finalRuntime.getActiveSessionId()).to.equal(null);
    await finalRuntime.shutdown();
  });
});
