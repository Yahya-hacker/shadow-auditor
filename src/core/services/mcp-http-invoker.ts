/**
 * Standards-compliant MCP Streamable HTTP client with SSRF-safe DNS pinning.
 */

import type { LookupFunction } from 'node:net';

import * as http from 'node:http';
import * as https from 'node:https';

import type { MCPRawInvoker } from '../mcp/types.js';

import { logToStderr } from '../../utils/stderr-logger.js';
import { resolveExternalUrl, validateExternalUrl } from './ssrf-protection.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  error?: { code?: number; data?: unknown; message?: string };
  id?: number | string;
  jsonrpc: '2.0';
  result?: unknown;
}

interface PinnedRequest {
  address: string;
  body: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
  url: URL;
}

interface PinnedResponse {
  body: string;
  headers: http.IncomingHttpHeaders;
}

export function maybeCreateHttpInvoker(endpoint?: string): MCPRawInvoker | undefined {
  return createHttpInvoker(endpoint, resolveExternalUrl);
}

export function createHttpInvoker(
  endpoint: string | undefined,
  resolver: typeof resolveExternalUrl,
): MCPRawInvoker | undefined {
  const parsedUrl = validateExternalUrl(endpoint ?? '');
  if (!parsedUrl) {
    const normalized = endpoint?.trim();
    if (normalized) {
      logToStderr(`[MCP] Invalid or blocked endpoint URL: "${normalized}". MCP adapter disabled.`);
    }

    return undefined;
  }

  const validUrl = parsedUrl.href;
  let initializePromise: Promise<void> | undefined;
  let requestId = 0;
  let sessionId: string | undefined;

  async function rpc(
    method: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
    notification = false,
  ): Promise<unknown> {
    const id = notification ? undefined : ++requestId;
    const resolved = await resolver(validUrl);
    if (!resolved) {
      throw new Error('MCP endpoint resolved to a blocked or unavailable address.');
    }

    const response = await pinnedPost({
      address: resolved.address,
      body: JSON.stringify({
        ...(id === undefined ? {} : { id }),
        jsonrpc: '2.0',
        method,
        params: parameters,
      }),
      family: resolved.family,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      signal,
      url: resolved.url,
    });
    const responseSession = response.headers['mcp-session-id'];
    if (typeof responseSession === 'string' && responseSession.trim()) {
      sessionId = responseSession;
    }

    if (id === undefined || !response.body.trim()) return undefined;
    const payload = parseMcpResponse(response.body, id);
    if (payload.error) {
      const code = payload.error.code === undefined ? '' : ` (${payload.error.code})`;
      throw new Error(`MCP ${method} failed${code}: ${payload.error.message ?? 'Unknown error'}`);
    }

    return payload.result;
  }

  async function initialize(signal: AbortSignal): Promise<void> {
    await rpc('initialize', {
      capabilities: {},
      clientInfo: { name: 'shadow-auditor', version: '1.0.0' },
      protocolVersion: MCP_PROTOCOL_VERSION,
    }, signal);
    await rpc('notifications/initialized', {}, signal, true);
  }

  return async (operation: string, input: Record<string, unknown>, signal?: AbortSignal) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('MCP request timed out.')), 30_000);
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      initializePromise ??= initialize(controller.signal).catch((error: unknown) => {
        initializePromise = undefined;
        sessionId = undefined;
        throw error;
      });
      await initializePromise;
      return await rpc('tools/call', { arguments: input, name: operation }, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };
}

function parseMcpResponse(body: string, expectedId: number): JsonRpcResponse {
  const candidates = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  const sources = candidates.length > 0 ? candidates : [body];

  for (const source of sources) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      continue;
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
      (parsed as { id?: unknown }).id === expectedId
    ) {
      return parsed as JsonRpcResponse;
    }
  }

  throw new Error('MCP endpoint returned an invalid JSON-RPC response.');
}

async function pinnedPost(requestOptions: PinnedRequest): Promise<PinnedResponse> {
  const { address, body, family, headers, signal, url } = requestOptions;
  const transport = url.protocol === 'https:' ? https : http;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };

  return new Promise<PinnedResponse>((resolve, reject) => {
    const request = transport.request(url, {
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body).toString(),
        'content-type': 'application/json',
      },
      lookup,
      method: 'POST',
      signal,
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`MCP endpoint error (${statusCode}): ${response.statusMessage ?? 'Unknown error'}`));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('MCP endpoint response exceeded the 10 MiB limit.'));
          return;
        }

        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}
