import {ChatMistralAI} from '@langchain/mistralai';
import { ChatOllama } from '@langchain/ollama';
import {ChatOpenAI} from '@langchain/openai';
import { expect } from 'chai';

import {
  classifyModelTier,
  clearModelCache,
  computeTrustScore,
  resolveWorkerTier,
  type SwarmModelOverrides,
} from '../src/core/hivemind/swarm-model-router.js';
import { getLangchainModel } from '../src/core/model-router.js';

describe('swarm-model-router', () => {
  afterEach(() => {
    clearModelCache();
  });

  describe('classifyModelTier', () => {
    it('classifies Anthropic flagship models as premium', () => {
      expect(classifyModelTier('anthropic', 'claude-opus-4.5')).to.equal('premium');
      expect(classifyModelTier('anthropic', 'claude-sonnet-4')).to.equal('premium');
      expect(classifyModelTier('anthropic', 'claude-3.5-sonnet-20241022')).to.equal('premium');
    });

    it('classifies Anthropic Haiku as standard', () => {
      expect(classifyModelTier('anthropic', 'claude-haiku-4')).to.equal('standard');
    });

    it('classifies OpenAI flagship models as premium', () => {
      expect(classifyModelTier('openai', 'gpt-5.3-codex')).to.equal('premium');
      expect(classifyModelTier('openai', 'gpt-4o-2024-05-13')).to.equal('premium');
      expect(classifyModelTier('openai', 'o1-preview')).to.equal('premium');
    });

    it('classifies OpenAI mini as standard', () => {
      expect(classifyModelTier('openai', 'gpt-4o-mini')).to.equal('standard');
    });

    it('classifies Google Pro as premium', () => {
      expect(classifyModelTier('google', 'gemini-2.5-pro')).to.equal('premium');
    });

    it('classifies Google Flash as standard', () => {
      expect(classifyModelTier('google', 'gemini-2.0-flash')).to.equal('standard');
    });

    it('classifies Mistral Large as premium', () => {
      expect(classifyModelTier('mistral', 'mistral-large-latest')).to.equal('premium');
    });

    it('classifies Mistral Small as standard', () => {
      expect(classifyModelTier('mistral', 'mistral-small-latest')).to.equal('standard');
    });

    it('classifies Ollama models as local', () => {
      expect(classifyModelTier('ollama', 'llama3.1:70b')).to.equal('local');
      expect(classifyModelTier('ollama', 'qwen2:7b')).to.equal('local');
    });

    it('classifies custom providers as local', () => {
      expect(classifyModelTier('custom', 'my-fine-tuned-model')).to.equal('local');
    });

    it('classifies unknown models from known providers as standard', () => {
      expect(classifyModelTier('anthropic', 'claude-future-6')).to.equal('standard');
      expect(classifyModelTier('openai', 'gpt-future-99')).to.equal('standard');
    });

    it('is case-insensitive for provider', () => {
      expect(classifyModelTier('ANTHROPIC', 'claude-opus-4.5')).to.equal('premium');
      expect(classifyModelTier('  OpenAI  ', 'gpt-5.3-codex')).to.equal('premium');
    });
  });

  describe('getLangchainModel', () => {
    it('rejects unknown providers instead of silently using OpenAI', () => {
      let error: unknown;
      try {
        getLangchainModel({ apiKey: 'key', model: 'model', provider: 'unsupported' });
      } catch (error_) {
        error = error_;
      }

      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Unknown provider');
    });

    it('requires a base URL for custom providers', () => {
      let error: unknown;
      try {
        getLangchainModel({ apiKey: 'key', model: 'model', provider: 'custom' });
      } catch (error_) {
        error = error_;
      }

      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('requires customBaseUrl');
    });

    it('fails clearly for Perplexity instead of issuing incompatible tool calls', () => {
      expect(() =>
        getLangchainModel({apiKey: 'key', model: 'sonar-pro', provider: 'perplexity'}),
      ).to.throw('does not support the external tool contract');
    });

    it('constructs OpenRouter through the OpenAI-compatible adapter', () => {
      const model = getLangchainModel({
        apiKey: 'key',
        model: 'openrouter/auto',
        provider: 'openrouter',
      });

      expect(model).to.be.instanceOf(ChatOpenAI);
      expect(classifyModelTier('openrouter', 'openrouter/auto')).to.equal('standard');
    });

    it('uses the native Mistral integration', () => {
      const model = getLangchainModel({
        apiKey: 'key',
        model: 'mistral-large-latest',
        provider: 'mistral',
      });

      expect(model).to.be.instanceOf(ChatMistralAI);
    });

    it('uses the native Ollama integration and preserves its host URL', () => {
      const model = getLangchainModel({
        apiKey: '',
        customBaseUrl: 'http://ollama.internal:11434',
        model: 'qwen3:8b',
        provider: 'ollama',
      });

      expect(model).to.be.instanceOf(ChatOllama);
      expect(model).to.have.property('baseUrl', 'http://ollama.internal:11434');
    });

    it('does not force temperature on DeepSeek V4 reasoning models', () => {
      const model = getLangchainModel({
        apiKey: 'key',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
      });

      expect(model).to.have.property('temperature', undefined);
    });

    it('maps UI reasoning controls to DeepSeek request parameters', () => {
      const enabled = getLangchainModel({
        apiKey: 'key',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        reasoningEffort: 'medium',
      }) as ChatOpenAI;
      const disabled = getLangchainModel({
        apiKey: 'key',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        reasoningEffort: 'none',
      }) as ChatOpenAI;

      expect(enabled.modelKwargs).to.deep.equal({
        reasoning_effort: 'high',
        thinking: {type: 'enabled'},
      });
      expect(disabled.modelKwargs).to.deep.equal({
        thinking: {type: 'disabled'},
      });
    });

          it('sets a bounded request timeout on OpenAI-compatible providers', () => {
            const model = getLangchainModel({
              apiKey: 'key',
              model: 'gpt-4o',
              provider: 'openai',
            }) as ChatOpenAI;

            expect(model.timeout).to.equal(120_000);
          });
        });

  describe('computeTrustScore', () => {
    it('returns 0.9 for premium tier', () => {
      expect(computeTrustScore('premium')).to.equal(0.9);
    });

    it('returns 0.7 for standard tier', () => {
      expect(computeTrustScore('standard')).to.equal(0.7);
    });

    it('returns 0.5 for local tier', () => {
      expect(computeTrustScore('local')).to.equal(0.5);
    });
  });

  describe('resolveWorkerTier', () => {
    it('uses default provider/model when no overrides', () => {
      const result = resolveWorkerTier('recon', 'anthropic', 'claude-opus-4.5');
      expect(result.modelTier).to.equal('premium');
      expect(result.trustScore).to.equal(0.9);
    });

    it('uses override provider/model when specified', () => {
      const overrides: SwarmModelOverrides = {
        recon: { model: 'llama3.1:70b', provider: 'ollama' },
      };

      const result = resolveWorkerTier('recon', 'anthropic', 'claude-opus-4.5', overrides);
      expect(result.modelTier).to.equal('local');
      expect(result.trustScore).to.equal(0.5);
    });

    it('falls back to default for roles without overrides', () => {
      const overrides: SwarmModelOverrides = {
        recon: { model: 'llama3.1:70b', provider: 'ollama' },
      };

      const result = resolveWorkerTier('exploit-analyst', 'anthropic', 'claude-opus-4.5', overrides);
      expect(result.modelTier).to.equal('premium');
      expect(result.trustScore).to.equal(0.9);
    });
  });
});
