import {expect} from 'chai';

import {OllamaEmbeddingProvider} from '../src/core/memory/embeddings/ollama-provider.js';

describe('Ollama embedding provider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the native batch endpoint and preserves input order', async () => {
    let requestBody: unknown;
    let requestUrl = '';
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: [[1, 0, 0], [0, 1, 0]],
      }), {headers: {'content-type': 'application/json'}, status: 200});
    };

    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434/',
      dimension: 3,
      model: 'local-code-embed',
    });

    expect(await provider.embed(['first', 'second'])).to.deep.equal([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(requestUrl).to.equal('http://localhost:11434/api/embed');
    expect(requestBody).to.deep.equal({
      input: ['first', 'second'],
      model: 'local-code-embed',
    });
  });

  it('rejects malformed vector counts, dimensions, and non-finite values', async () => {
    const responses = [
      {embeddings: [[1, 2, 3]]},
      {embeddings: [[1, 2], [1, 2, 3]]},
      {embeddings: [[1, 2, 3], [1, 2, 'invalid']]},
    ];
    globalThis.fetch = async () => new Response(
      JSON.stringify(responses.shift()),
      {headers: {'content-type': 'application/json'}, status: 200},
    );
    const provider = new OllamaEmbeddingProvider({dimension: 3});

    await expectRejected(provider.embed(['first', 'second']), 'count mismatch');
    await expectRejected(provider.embed(['first', 'second']), 'exactly 3 finite numbers');
    await expectRejected(provider.embed(['first', 'second']), 'exactly 3 finite numbers');
  });
});

async function expectRejected(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation;
    throw new Error('Expected operation to reject.');
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include(message);
  }
}
