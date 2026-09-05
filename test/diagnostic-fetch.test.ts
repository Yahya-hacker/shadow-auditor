import {expect} from 'chai';

import {diagnosticOpenAIFetch} from '../src/core/providers/diagnostic-fetch.js';

interface Upstream {
  body?: string;
  contentType?: string;
  status: number;
}

function stubUpstream(value: Upstream): typeof fetch {
  return (async () => new Response(value.body ?? '', {
    headers: value.contentType ? {'content-type': value.contentType} : undefined,
    status: value.status,
    statusText: value.status === 200 ? 'OK' : 'Bad Request',
  })) as typeof fetch;
}

function chatRequest(model = 'zhipu/GLM-5.3'): {body: string} {
  return {body: JSON.stringify({model})};
}

async function readError(response: Response): Promise<{code?: string; message: string; type: string;}> {
  const parsed = JSON.parse(await response.text()) as {error: {code?: string; message: string; type: string;}};
  return parsed.error;
}

describe('diagnosticOpenAIFetch', () => {
  it('leaves successful responses untouched', async () => {
    const wrapped = diagnosticOpenAIFetch(
      stubUpstream({body: 'ok', contentType: 'application/json', status: 200}),
      {provider: 'qwen'},
    );

    const response = await wrapped('https://api.invalid/v1/chat/completions', chatRequest());

    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal('ok');
  });

  it('substitutes an actionable diagnostic for an empty 400 body', async () => {
    const wrapped = diagnosticOpenAIFetch(
      stubUpstream({status: 400}),
      {provider: 'qwen'},
    );

    const response = await wrapped(
      'https://dashscope.invalid/v1/chat/completions',
      chatRequest('zhipu/GLM-5.3'),
    );
    const error = await readError(response);

    expect(response.status).to.equal(400);
    expect(error.type).to.equal('provider_request_rejected');
    expect(error.message).to.include('HTTP 400');
    expect(error.message).to.include('"qwen"');
    expect(error.message).to.include('zhipu/GLM-5.3');
    expect(error.message).to.include('/v1/chat/completions');
    expect(error.message).to.not.include('status code (no body)');
  });

  it('surfaces a non-standard JSON error envelope instead of "no body"', async () => {
    const wrapped = diagnosticOpenAIFetch(
      stubUpstream({
        body: JSON.stringify({code: 'invalid_parameter', msg: 'model glM does not exist'}),
        contentType: 'application/json',
        status: 400,
      }),
      {provider: 'custom'},
    );

    const response = await wrapped('https://gateway.invalid/v1/chat/completions', chatRequest());
    const error = await readError(response);

    expect(response.status).to.equal(400);
    expect(error.message).to.equal('model glM does not exist');
    expect(error.code).to.equal('invalid_parameter');
  });

  it('preserves an OpenAI-shaped error object verbatim', async () => {
    const body = JSON.stringify({error: {message: 'real provider error', type: 'invalid_request_error'}});
    const wrapped = diagnosticOpenAIFetch(
      stubUpstream({body, contentType: 'application/json', status: 400}),
      {provider: 'openrouter'},
    );

    const response = await wrapped('https://openrouter.invalid/v1', chatRequest());

    expect(await response.text()).to.equal(body);
  });

  it('passes non-JSON bodies through to the SDK', async () => {
    const wrapped = diagnosticOpenAIFetch(
      stubUpstream({body: 'plain text rejection', contentType: 'text/plain', status: 400}),
      {provider: 'moonshot'},
    );

    const response = await wrapped('https://api.invalid/v1', chatRequest());

        expect(await response.text()).to.equal('plain text rejection');
      });
    });