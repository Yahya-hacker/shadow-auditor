import { expect } from 'chai';
import { randomUUID } from 'node:crypto';

import type { DeviceRefreshResponse, ToolDecision } from '../src/protocol/generated.js';

import { RemoteApiClient } from '../src/core/remote/api-client.js';
import { ProtocolError } from '../src/core/remote/protocol-error.js';
import { sha256Digest } from '../src/protocol/canonical-json.js';
import { createDeviceCredentials, createTestVault } from './remote-fixtures.js';

describe('remote API client', () => {
  it('refreshes an expired SSE request and reconnects from the same cursor', async () => {
    const initial = createDeviceCredentials();
    const { store, vault } = await createTestVault(initial);
    const calls: Array<{ authorization: null | string; url: string }> = [];
    const refreshed: DeviceRefreshResponse = {
      deviceId: initial.deviceId,
      protocolVersion: '1.0',
      serverTime: new Date().toISOString(),
      tokens: {
        ...initial.tokens,
        accessToken: 'new-access-token-value-000000000000',
      },
    };
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url,
      });
      if (calls.length === 1) return new Response(null, { status: 401 });
      if (url.endsWith('/v1/auth/device/refresh')) {
        return Response.json(refreshed);
      }

      return new Response('', {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      });
    };

    const client = new RemoteApiClient({
      backendUrl: 'https://backend.example.test',
      credentialAccount: 'test',
      fetchImplementation,
      vault,
    });

    const stream = await client.streamEvents(randomUUID(), 17, 4096);
    expect((await stream[Symbol.asyncIterator]().next()).done).to.equal(true);

    expect(calls).to.have.length(3);
    expect(calls[0]?.url).to.match(/\?cursor=17$/);
    expect(calls[2]?.url).to.match(/\?cursor=17$/);
    expect(calls[0]?.authorization).to.equal(`Bearer ${initial.tokens.accessToken}`);
    expect(calls[2]?.authorization).to.equal(`Bearer ${refreshed.tokens.accessToken}`);
    expect(JSON.parse(store.value ?? '{}').tokens.accessToken).to.equal(refreshed.tokens.accessToken);
  });

  it('binds prepared decisions to the device, payload digest, method, and path', async () => {
    const initial = createDeviceCredentials();
    const { vault } = await createTestVault(initial);
    let submittedBody = '';
    const fetchImplementation: typeof fetch = async (_input, init) => {
      submittedBody = String(init?.body ?? '');
      return new Response(null, { status: 204 });
    };

    const client = new RemoteApiClient({
      backendUrl: 'https://backend.example.test',
      credentialAccount: 'test',
      fetchImplementation,
      vault,
    });
    const sessionId = randomUUID();
    const proposalId = randomUUID();
    const unsigned: Omit<ToolDecision, 'request'> = {
      actor: 'human',
      argumentsDigest: sha256Digest({ path: 'src/index.ts' }),
      decidedAt: new Date().toISOString(),
      decision: 'approve',
      decisionId: randomUUID(),
      proposalId,
      protocolVersion: '1.0',
      reason: 'Approved in test',
      sessionId,
    };
    const prepared = await client.prepareDecision(sessionId, unsigned);
    await client.submitDecision(sessionId, prepared);
    expect(JSON.parse(submittedBody)).to.deep.equal(prepared);

    const tampered = { ...prepared, reason: 'tampered after signing' };
    let failure: unknown;
    try {
      await client.submitDecision(sessionId, tampered);
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(ProtocolError);
    expect((failure as ProtocolError).problem.code).to.equal('INVALID_PREPARED_REQUEST');
  });

  it('rejects cleartext backend URLs', () => {
    expect(() => new RemoteApiClient({
      backendUrl: 'http://backend.example.test',
      credentialAccount: 'test',
    })).to.throw('HTTPS');
  });
});
