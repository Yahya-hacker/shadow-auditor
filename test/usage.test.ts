import {expect} from 'chai';

import {normalizeTokenUsage} from '../src/core/usage.js';

describe('normalizeTokenUsage', () => {
  for (const fixture of [
    {
      label: 'OpenAI, Azure, Anthropic, Ollama, and Kimi LangChain metadata',
      message: {
        usage_metadata: {input_tokens: 12, output_tokens: 3, total_tokens: 15},
      },
    },
    {
      label: 'Google usage metadata',
      message: {
        usageMetadata: {
          candidatesTokenCount: 3,
          promptTokenCount: 12,
          totalTokenCount: 15,
        },
      },
    },
    {
      label: 'DeepSeek and Mistral response metadata',
      message: {
        response_metadata: {
          tokenUsage: {completionTokens: 3, promptTokens: 12, totalTokens: 15},
        },
      },
    },
    {
      label: 'OpenAI-compatible raw usage',
      message: {
        responseMetadata: {
          usage: {completion_tokens: 3, prompt_tokens: 12, total_tokens: 15},
        },
      },
    },
  ]) {
    it(`normalizes ${fixture.label}`, () => {
      expect(normalizeTokenUsage(fixture.message)).to.deep.equal({
        completion: 3,
        prompt: 12,
        total: 15,
        totalSource: 'provider',
        unclassified: 0,
      });
    });
  }

  it('derives totals and ignores invalid counters', () => {
    expect(normalizeTokenUsage({
      usage_metadata: {input_tokens: 7.9, output_tokens: 2, total_tokens: -1},
    })).to.deep.equal({
      completion: 2,
      prompt: 7,
      total: 9,
      totalSource: 'derived',
      unclassified: 0,
    });
    expect(normalizeTokenUsage({usage_metadata: {input_tokens: Number.NaN}})).to.equal(undefined);
  });

  it('preserves total-only provider accounting without inventing prompt or completion counts', () => {
    expect(normalizeTokenUsage({
      usage_metadata: {total_tokens: 21},
    })).to.deep.equal({
      completion: 0,
      prompt: 0,
      total: 21,
      totalSource: 'provider',
      unclassified: 21,
    });
  });
});
