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
        expect(settings.maxToolSteps).to.equal(22);
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
    });
  });

  describe('budget manager', () => {
    let manager: BudgetManager;

    beforeEach(() => {
      manager = new BudgetManager({
        criticalThreshold: 95,
        outputTokensBudget: 10_000,
        runId: 'test-run',
        toolStepsBudget: 20,
        warningThreshold: 80,
      });
    });

    describe('recording usage', () => {
      it('tracks token usage', () => {
        manager.recordTokens(1000);
        manager.recordTokens(500);

        const status = manager.getStatus();
        expect(status.outputTokensUsed).to.equal(1500);
        expect(status.outputTokensRemaining).to.equal(8500);
      });

      it('tracks step usage', () => {
        manager.recordStep();
        manager.recordStep();
        manager.recordStep();

        const status = manager.getStatus();
        expect(status.toolStepsUsed).to.equal(3);
        expect(status.toolStepsRemaining).to.equal(17);
      });

      it('calculates percentages', () => {
        manager.recordTokens(5000);
        manager.recordStep();
        manager.recordStep();
        manager.recordStep();
        manager.recordStep();
        manager.recordStep();

        const status = manager.getStatus();
        expect(status.outputTokensPercent).to.equal(50);
        expect(status.toolStepsPercent).to.equal(25);
      });
    });

    describe('budget checking', () => {
      it('hasBudget returns true when budget is available', () => {
        manager.recordTokens(5000);
        manager.recordStep();
        expect(manager.hasBudget()).to.equal(true);
      });

      it('hasBudget returns false when tokens are exhausted', () => {
        manager.recordTokens(10_000);
        expect(manager.hasBudget()).to.equal(false);
      });

      it('hasBudget returns false when steps are exhausted', () => {
        for (let index = 0; index < 20; index++) {
          manager.recordStep();
        }

        expect(manager.hasBudget()).to.equal(false);
      });

      it('canAfford estimates remaining budget correctly', () => {
        manager.recordTokens(8000);
        expect(manager.canAfford(1000)).to.equal(true);
        expect(manager.canAfford(3000)).to.equal(false);
      });
    });

    describe('continuation detection', () => {
      it('needsContinuation returns false initially', () => {
        expect(manager.needsContinuation()).to.equal(false);
      });

      it('needsContinuation returns true at critical threshold', () => {
        manager.recordTokens(9600);
        expect(manager.needsContinuation()).to.equal(true);
      });

      it('needsContinuation returns true when exhausted', () => {
        manager.recordTokens(10_000);
        expect(manager.needsContinuation()).to.equal(true);
      });
    });

    describe('events', () => {
      it('emits warning at threshold', (done) => {
        manager.on('warning', (status) => {
          expect(status.outputTokensPercent).to.be.at.least(80);
          done();
        });
        manager.recordTokens(8000);
      });

      it('emits critical at threshold', (done) => {
        manager.on('critical', (status) => {
          expect(status.outputTokensPercent).to.be.at.least(95);
          done();
        });
        manager.recordTokens(9500);
      });

      it('emits exhausted when budget is depleted', (done) => {
        manager.on('exhausted', (status) => {
          expect(status.isExhausted).to.equal(true);
          done();
        });
        manager.recordTokens(10_000);
      });
    });

    describe('getSummary', () => {
      it('returns a human-readable summary', () => {
        manager.recordTokens(5000);
        manager.recordStep();
        manager.recordStep();

        const summary = manager.getSummary();
        expect(summary).to.include('5000');
        expect(summary).to.include('10000');
        expect(summary).to.include('2');
      });

      it('includes continuation notice when needed', () => {
        manager.recordTokens(9600);
        const summary = manager.getSummary();
        expect(summary).to.include('CONTINUATION REQUIRED');
      });
    });

    describe('createBudgetManager', () => {
      it('creates manager from runtime settings', () => {
        const settings = resolveRuntimeSettings({
          maxOutputTokens: 30_000,
          maxToolSteps: 15,
          model: 'claude-sonnet-4.5',
          provider: 'anthropic',
        });

        const built = createBudgetManager('run-123', settings);
        const status = built.getStatus();
        expect(status.outputTokensBudget).to.equal(30_000);
        expect(status.toolStepsBudget).to.equal(15);
      });
    });
  });
});
