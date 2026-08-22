import {expect} from 'chai';

import {
  getProviderBaseUrl,
  getProviderEmbeddingDimension,
  getProviderModels,
  isOpenAICompatibleProvider,
  providerHasNativeEmbedding,
  providerRequiresApiKey,
} from '../src/utils/provider-catalog.js';

describe('provider catalog contracts', () => {
  it('routes OpenRouter through its OpenAI-compatible endpoint', () => {
    expect(isOpenAICompatibleProvider('openrouter')).to.equal(true);
    expect(getProviderBaseUrl('openrouter')).to.equal('https://openrouter.ai/api/v1');
    expect(getProviderModels('openrouter')).to.deep.include({
      label: 'Auto (recommended)',
      value: 'openrouter/auto',
    });
  });

  it('uses Qwen public endpoints without a tenant-specific workspace identifier', () => {
    expect(getProviderBaseUrl('qwen')).to.equal(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(getProviderBaseUrl('qwen')).not.to.include('workspaces/');
    expect(getProviderBaseUrl('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'))
      .to.equal('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('permits explicitly configured unauthenticated custom endpoints', () => {
    expect(providerRequiresApiKey('custom')).to.equal(false);
  });

  it('declares only verified cloud embedding contracts', () => {
    expect(providerHasNativeEmbedding('deepseek')).to.equal(false);
    expect(providerHasNativeEmbedding('moonshot')).to.equal(false);
    expect(providerHasNativeEmbedding('qwen')).to.equal(false);
    expect(getProviderEmbeddingDimension('nvidia')).to.equal(1024);
  });

  it('does not recommend retired Google model generations', () => {
    const models = getProviderModels('google') ?? [];
    expect(models).not.to.include('gemini-1.5-pro');
    expect(models).not.to.include('gemini-2.0-flash');
  });

  it('does not recommend Ollama tags without a verified tool contract', () => {
    const models = getProviderModels('ollama')?.map(({value}) => value) ?? [];
    expect(models).not.to.include.members(['codellama:13b', 'deepseek-r1', 'mistral']);
  });
});
