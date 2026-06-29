import { expect } from 'chai';

import type { AuditMode } from '../src/core/model-capabilities.js';

import { auditModeBudgetMultiplier, resolveRuntimeSettings } from '../src/core/model-capabilities.js';

describe('audit modes', () => {
  describe('auditModeBudgetMultiplier', () => {
    const modes: AuditMode[] = ['triage', 'quick', 'patch-only', 'balanced', 'deep', 'deep-sast', 'full-report'];

    for (const mode of modes) {
      it(`returns valid multiplier for "${mode}"`, () => {
        const m = auditModeBudgetMultiplier(mode);
        expect(m.tokens).to.be.a('number').and.greaterThan(0);
        expect(m.steps).to.be.a('number').and.greaterThan(0);
      });
    }

    it('triage uses smaller budget than deep-sast', () => {
      const triage = auditModeBudgetMultiplier('triage');
      const deep   = auditModeBudgetMultiplier('deep-sast');
      expect(triage.tokens).to.be.lessThan(deep.tokens);
      expect(triage.steps).to.be.lessThan(deep.steps);
    });

    it('full-report uses at least as many tokens as deep-sast', () => {
      const full = auditModeBudgetMultiplier('full-report');
      const deep = auditModeBudgetMultiplier('deep-sast');
      expect(full.tokens).to.be.at.least(deep.tokens);
    });

    it('patch-only uses smaller budget than deep-sast', () => {
      const patch = auditModeBudgetMultiplier('patch-only');
      const deep  = auditModeBudgetMultiplier('deep-sast');
      expect(patch.tokens).to.be.lessThan(deep.tokens);
    });
  });

  describe('resolveRuntimeSettings with auditMode', () => {
    const baseConfig = { model: 'claude-sonnet-4.5', provider: 'anthropic' };

    it('applies triage multiplier — fewer tokens and steps than deep-sast', () => {
      const triage   = resolveRuntimeSettings(baseConfig, undefined, 'triage');
      const deepSast = resolveRuntimeSettings(baseConfig, undefined, 'deep-sast');
      expect(triage.maxOutputTokens).to.be.lessThan(deepSast.maxOutputTokens);
      expect(triage.maxToolSteps).to.be.lessThan(deepSast.maxToolSteps);
    });

    it('full-report budget is >= deep-sast budget', () => {
      const full = resolveRuntimeSettings(baseConfig, undefined, 'full-report');
      const deep = resolveRuntimeSettings(baseConfig, undefined, 'deep-sast');
      expect(full.maxOutputTokens).to.be.at.least(deep.maxOutputTokens);
    });

    it('always returns at least 1 token and 1 step', () => {
      const settings = resolveRuntimeSettings(baseConfig, undefined, 'triage');
      expect(settings.maxOutputTokens).to.be.at.least(1);
      expect(settings.maxToolSteps).to.be.at.least(1);
    });
  });
});
