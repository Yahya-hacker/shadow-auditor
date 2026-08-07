import { expect } from 'chai';

import {
  classifyModelTier,
  clearModelCache,
  computeTrustScore,
  resolveWorkerTier,
  type SwarmModelOverrides,
} from '../src/core/hivemind/swarm-model-router.js';

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
