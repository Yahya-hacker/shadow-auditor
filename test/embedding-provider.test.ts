import {expect} from 'chai';

import {OpenAIEmbeddingProvider} from '../src/core/memory/embeddings/openai-provider.js';
import {createEmbeddingProvider} from '../src/core/services/model-initializer.js';

async function captureError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
    throw new Error('Expected operation to fail');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe('OpenAI-compatible embedding provider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accepts an unauthenticated endpoint and restores provider ordering', async () => {
    let requestHeaders: ConstructorParameters<typeof Headers>[0];
    globalThis.fetch = async (_input, init) => {
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({
        data: [
          {embedding: [4, 5, 6], index: 1},
          {embedding: [1, 2, 3], index: 0},
        ],
      }), {headers: {'content-type': 'application/json'}, status: 200});
    };

    const provider = new OpenAIEmbeddingProvider({
      apiKey: '',
      baseUrl: 'http://localhost:8080/v1',
      dimension: 3,
      model: 'local-embed',
      providerName: 'custom',
    });

    expect(await provider.embed(['first', 'second'])).to.deep.equal([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(new Headers(requestHeaders).has('authorization')).to.equal(false);
  });

  it('uses Azure API-key headers and exact deployment endpoints', async () => {
    let requestHeaders = new Headers();
    let requestUrl = '';
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [{embedding: [1, 2, 3], index: 0}],
      }), {headers: {'content-type': 'application/json'}, status: 200});
    };

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'azure-secret',
      credentialHeader: 'api-key',
      dimension: 3,
      endpointUrl: 'https://audit.openai.azure.com/openai/v1/embeddings',
      model: 'embedding-deployment',
      providerName: 'azure',
    });

    expect(await provider.embed(['input'])).to.deep.equal([[1, 2, 3]]);
    expect(requestUrl).to.equal(
      'https://audit.openai.azure.com/openai/v1/embeddings',
    );
    expect(requestHeaders.get('api-key')).to.equal('azure-secret');
    expect(requestHeaders.has('authorization')).to.equal(false);
  });

  it('sends an explicitly configured output dimension and validates health response shape', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        data: [{embedding: [1, 2, 3], index: 0}],
      }), {headers: {'content-type': 'application/json'}, status: 200});
    };

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'key',
      dimension: 3,
      requestDimension: true,
    });

    expect(await provider.testConnection()).to.equal(true);
    expect(requestBody).to.deep.equal({
      dimensions: 3,
      input: ['test'],
      model: 'text-embedding-3-small',
    });
  });

  it('uses one bounded request for health checks instead of retrying throttling responses', async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({error: {message: 'rate limited'}}), {
        headers: {'content-type': 'application/json', 'retry-after': '3600'},
        status: 429,
      });
    };

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'key',
      dimension: 3,
    });

    expect(await provider.testConnection()).to.equal(false);
    expect(attempts).to.equal(1);
  });

  it('treats configured dimensions as response validation for compatible providers', async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        data: [{embedding: [1, 2, 3], index: 0}],
      }), {headers: {'content-type': 'application/json'}, status: 200});
    };

    const provider = createEmbeddingProvider({
      apiKey: 'key',
      indexing: {
        embeddingDimension: 3,
        embeddingModel: 'fixed-dimension-model',
        embeddingProvider: 'openai',
      },
      model: 'chat-model',
      provider: 'openai',
    });

    expect(await provider.embed(['input'])).to.deep.equal([[1, 2, 3]]);
    expect(requestBody).not.to.have.property('dimensions');
  });

  it('rejects response count and dimension contract violations', async () => {
    const responses = [
      {data: [{embedding: [1, 2, 3], index: 0}]},
      {data: [{embedding: [1, 2], index: 0}, {embedding: [3, 4, 5], index: 1}]},
    ];
    globalThis.fetch = async () => new Response(
      JSON.stringify(responses.shift()),
      {headers: {'content-type': 'application/json'}, status: 200},
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'key',
      dimension: 3,
    });

    expect((await captureError(provider.embed(['first', 'second']))).message)
      .to.include('Embedding response count mismatch');
    expect((await captureError(provider.embed(['first', 'second']))).message)
      .to.include('expected 3 finite dimensions');
  });

  it('does not retry an externally aborted request', async () => {
    let calls = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      calls++;
      markStarted?.();
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true});
      });
      throw new Error('unreachable');
    };

    const provider = new OpenAIEmbeddingProvider({apiKey: 'key'});
    const controller = new AbortController();
    const embedding = provider.embed(['text'], controller.signal);
    await started;
    controller.abort(new DOMException('cancelled', 'AbortError'));

    expect((await captureError(embedding)).message).to.include('cancelled');
    expect(calls).to.equal(1);
  });
});
