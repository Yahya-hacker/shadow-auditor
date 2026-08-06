/* eslint-disable max-nested-callbacks */
import { expect } from 'chai';

import {
  BudgetManager,
  createBudgetManager,
  resolveModelCapabilities,
  resolveRuntimeSettings,
} from '../src/core/model-capabilities.js';

describe('model budget subsystem', () => {
  describe('model capabilities', () => {
    describe('resolveModelCapabilities', () => {
      it('returns capabilities for Claude models', () => {
        const caps = resolveModelCapabilities({
          model: 'claude-sonnet-4.5',
          provider: 'anthropic',
        });

        expect(caps.maxOutputTokens).to.equal(64_000);
        expect(caps.supportsLongOutput).to.equal(true);
        expect(caps.supportsReasoningMode).to.equal(false);
      });

      it('advertises only executable DeepSeek reasoning controls', () => {
        const caps = resolveModelCapabilities({
          model: 'deepseek-v4-pro',
          provider: 'deepseek',
        });

        expect(caps.supportsReasoningMode).to.equal(true);
      });

      it('returns capabilities for GPT-5.3 Codex', () => {
        const caps = resolveModelCapabilities({
          model: 'gpt-5.3-codex',
          provider: 'openai',
        });

        expect(caps.maxOutputTokens).to.equal(48_000);
        expect(caps.preferredAuditMode).to.equal('deep');
      });

      it('returns the GPT-5.6 Sol context and output limits', () => {
        const caps = resolveModelCapabilities({
          model: 'gpt-5.6-sol',
          provider: 'openai',
        });

        expect(caps.contextWindowTokens).to.equal(1_000_000);
        expect(caps.maxOutputTokens).to.equal(128_000);
        expect(caps.supportsReasoningMode).to.equal(true);
      });

      it('returns fallback for unknown provider', () => {
        const caps = resolveModelCapabilities({
          model: 'some-model',
          provider: 'unknown-provider',
        });

        expect(caps.maxOutputTokens).to.equal(16_000);
        expect(caps.supportsLongOutput).to.equal(false);
      });

      it('returns safe defaults for Ollama', () => {
        const caps = resolveModelCapabilities({
          model: 'llama3',
          provider: 'ollama',
        });

        expect(caps.maxOutputTokens).to.equal(8000);
        expect(caps.preferredAuditMode).to.equal('quick');
      });
    });

    describe('resolveRuntimeSettings', () => {
      it('uses model defaults when no overrides provided', () => {
        const settings = resolveRuntimeSettings({
          maxOutputTokens: undefined,
          maxToolSteps: undefined,
          model: 'claude-opus-4.5',
          provider: 'anthropic',
        });

        expect(settings.maxOutputTokens).to.equal(64_000);
        expect(settings.maxToolSteps).to.equal(128);
      });

      it('clamps user-requested tokens to model max', () => {
        let warning: string | undefined;

        const settings = resolveRuntimeSettings(
          {
            maxOutputTokens: 100_000,
            maxToolSteps: 10,
            model: 'gpt-5-mini',
            provider: 'openai',
          },
          (message) => {
            warning = message;
          },
        );

        expect(settings.maxOutputTokens).to.equal(32_000);
        expect(warning).to.include('clamped');
      });

      it('respects user-requested limits when valid', () => {
        const settings = resolveRuntimeSettings({
          maxOutputTokens: 20_000,
          maxToolSteps: 10,
          model: 'claude-sonnet-4.5',
          provider: 'anthropic',
        });

        expect(settings.maxOutputTokens).to.equal(20_000);
        expect(settings.maxToolSteps).to.equal(10);
      });

      it('allows users to raise the model/tool iteration budget above provider defaults', () => {
        const settings = resolveRuntimeSettings({
          maxOutputTokens: 20_000,
          maxToolSteps: 128,
          model: 'claude-sonnet-4.5',
          provider: 'anthropic',
        });

        expect(settings.maxToolSteps).to.equal(128);
      });

      it('clamps audit-mode multipliers to provider limits', () => {
        const settings = resolveRuntimeSettings(
          {
            maxOutputTokens: undefined,
            maxToolSteps: undefined,
            model: 'gpt-5.6-sol',
            provider: 'openai',
          },
          undefined,
          'full-report',
        );

        expect(settings.maxOutputTokens).to.equal(128_000);
        expect(settings.maxToolSteps).to.equal(128);
      });
    });
  });

  describe('compatibility budget manager', () => {
    it('tracks an explicitly cumulative run budget', () => {
      const manager = new BudgetManager({
        outputTokensBudget: 100,
        runId: 'run-1',
        toolStepsBudget: 2,
      });

      manager.recordTokens(30);
      manager.recordStep();

      expect(manager.getStatus()).to.include({
        outputTokensRemaining: 70,
        outputTokensUsed: 30,
        toolStepsRemaining: 1,
        toolStepsUsed: 1,
      });
    });

    it('does not treat the per-call output ceiling as the mission budget', () => {
      const settings = resolveRuntimeSettings({
        maxOutputTokens: 100,
        maxToolSteps: 2,
        model: 'gpt-5-mini',
        provider: 'openai',
      });
      const manager = createBudgetManager('run-2', settings);

      expect(manager.getStatus().outputTokensBudget).to.equal(300);
    });
  });

});
