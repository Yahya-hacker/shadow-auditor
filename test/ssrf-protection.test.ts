import { expect } from 'chai';
import * as http from 'node:http';

import { createHttpInvoker } from '../src/core/services/mcp-http-invoker.js';
import {
  isBlockedHost,
  validateExternalUrl,
} from '../src/core/services/ssrf-protection.js';

describe('SSRF protection', () => {
  it('blocks private, loopback, link-local, carrier-grade NAT, reserved, and multicast IPv4', () => {
    for (const address of [
      '0.1.2.3',
      '10.1.2.3',
      '100.64.1.2',
      '127.0.0.2',
      '169.254.169.254',
      '172.31.255.255',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedHost(address), address).to.equal(true);
    }
  });

  it('blocks private and mapped IPv6 addresses while allowing public literals', () => {
    for (const address of [
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:808:808',
    ]) {
      expect(isBlockedHost(address), address).to.equal(true);
    }

    expect(isBlockedHost('8.8.8.8')).to.equal(false);
    expect(isBlockedHost('2606:4700:4700::1111')).to.equal(false);
  });

  it('rejects credentials and non-HTTP protocols', () => {
    expect(validateExternalUrl('file:///etc/passwd')).to.equal(null);
    expect(validateExternalUrl('https://user:secret@example.com')).to.equal(null);
    expect(validateExternalUrl('http://169.254.169.254/latest/meta-data')).to.equal(null);
    expect(validateExternalUrl('http://[::ffff:7f00:1]/')).to.equal(null);
    expect(validateExternalUrl('https://example.com/mcp')?.hostname).to.equal('example.com');
  });

      it('blocks IPv4-compatible IPv6 addresses that embed private IPv4 (#46)', () => {
        for (const address of [
          '::192.168.1.1',
          '::c0a8:101',
          '::c0a8:0101',
          '0:0:0:0:0:0:c0a8:101',
          '::0:0:c0a8:101',
          '::10.1.2.3',
          '::7f00:1',
        ]) {
          expect(isBlockedHost(address), `block ${address}`).to.equal(true);
        }

        for (const address of [
          '::8.8.8.8',
          '::808:808',
          '2606:4700:4700::1111',
        ]) {
          expect(isBlockedHost(address), `allow ${address}`).to.equal(false);
        }
      });

      it('rejects URLs whose host is an IPv4-compatible IPv6 private address (#46)', () => {
        expect(validateExternalUrl('http://[::192.168.1.1]/')).to.equal(null);
        expect(validateExternalUrl('http://[::c0a8:101]/')).to.equal(null);
        expect(validateExternalUrl('http://[::7f00:1]/')).to.equal(null);
        expect(validateExternalUrl('http://[0:0:0:0:0:0:c0a8:101]/')).to.equal(null);
        expect(validateExternalUrl('http://[::8.8.8.8]/')).to.not.equal(null);
      });

  it('cancels an in-flight MCP HTTP request', async () => {
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
      const invoker = createHttpInvoker(
        `http://example.com:${address.port}/mcp`,
        async (value) => ({
          address: '127.0.0.1',
          family: 4,
          url: new URL(value),
        }),
      );
      if (!invoker) throw new Error('Expected an MCP invoker.');
      const controller = new AbortController();
      const request = invoker('tools/call', {}, controller.signal);
      controller.abort(new Error('cancelled'));

      let error: unknown;
      try {
        await request;
      } catch (error_) {
        error = error_;
      }

      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal('cancelled');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('follows a 202 Accepted + Location poll chain for deferred tool calls (#34)', async () => {
    const requests: Array<{ body: Record<string, unknown>; method?: string; sessionId?: string }> = [];
    let pollCount = 0;
    let toolsCallId: unknown;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        requests.push({
          body,
          method: request.method,
          sessionId: request.headers['mcp-session-id'] as string | undefined,
        });

        const method = body.method as string | undefined;
        if (method === 'initialize') {
          response.setHeader('mcp-session-id', 'session-deferred');
          response.end(JSON.stringify({
            id: body.id,
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'test-server', version: '1.0.0' },
            },
          }));
          return;
        }

        if (method === 'notifications/initialized') {
          response.statusCode = 202;
          response.end();
          return;
        }

        // tools/call deferred with 202 + Location
        if (method === 'tools/call') {
          toolsCallId = body.id;
          response.statusCode = 202;
          response.setHeader('mcp-session-id', 'session-deferred');
          response.setHeader('location', `/poll/${pollCount++}`);
          response.end();
          return;
        }

        // Poll endpoint: return 202 + new Location until the third poll
        if (request.url?.startsWith('/poll/')) {
          if (pollCount < 3) {
            response.statusCode = 202;
            response.setHeader('mcp-session-id', 'session-deferred');
            response.setHeader('location', `/poll/${pollCount++}`);
            response.end();
            return;
          }

          response.setHeader('mcp-session-id', 'session-deferred');
          response.end(JSON.stringify({
            id: toolsCallId,
            jsonrpc: '2.0',
            result: { content: [{ text: 'slow scan done', type: 'text' }] },
          }));
          return;
        }

        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
      const invoker = createHttpInvoker(
        `http://example.com:${address.port}/mcp`,
        async (value) => ({ address: '127.0.0.1', family: 4, url: new URL(value) }),
      );
      if (!invoker) throw new Error('Expected an MCP invoker.');

      const result = await invoker('slow_scan', { target: 'example.com' });

      expect(result).to.deep.equal({ content: [{ text: 'slow scan done', type: 'text' }] });
      const toolsCall = requests.find(({ body }) => body.method === 'tools/call');
      expect(toolsCall?.sessionId).to.equal('session-deferred');

      const polls = requests.filter(({ method }) => method === 'GET');
      expect(polls.length).to.equal(3);
      pollCount = 8;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('negotiates an MCP session and invokes tools through JSON-RPC', async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      sessionId?: string;
    }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        requests.push({
          body,
          sessionId: request.headers['mcp-session-id'] as string | undefined,
        });
        if (body.method === 'initialize') {
          response.setHeader('mcp-session-id', 'session-123');
          response.end(JSON.stringify({
            id: body.id,
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'test-server', version: '1.0.0' },
            },
          }));
        } else if (body.method === 'notifications/initialized') {
          response.statusCode = 202;
          response.end();
        } else {
          response.end(JSON.stringify({
            id: body.id,
            jsonrpc: '2.0',
            result: { content: [{ text: 'scan complete', type: 'text' }] },
          }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
      const invoker = createHttpInvoker(
        `http://example.com:${address.port}/mcp`,
        async (value) => ({ address: '127.0.0.1', family: 4, url: new URL(value) }),
      );
      if (!invoker) throw new Error('Expected an MCP invoker.');

      const result = await invoker('nmap_scan', { target: 'example.com' });

      expect(result).to.deep.equal({ content: [{ text: 'scan complete', type: 'text' }] });
      expect(requests.map(({ body }) => body.method)).to.deep.equal([
        'initialize',
        'notifications/initialized',
        'tools/call',
      ]);
      expect(requests[1]?.sessionId).to.equal('session-123');
      expect(requests[2]?.sessionId).to.equal('session-123');
      expect(requests[2]?.body.params).to.deep.equal({
        arguments: { target: 'example.com' },
        name: 'nmap_scan',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
