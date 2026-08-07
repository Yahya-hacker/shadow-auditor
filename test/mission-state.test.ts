import { expect } from 'chai';

import {
  getAllowedTransitions,
  isTerminalPhase,
  isValidTransition,
  type MissionState,
  missionStateSchema,
  phaseAllowsToolExecution,
} from '../src/core/orchestrator/mission-state.js';
import {
  attemptTransition,
  calculateMissionConfidence,
  getAllowedTransitionsForState,
  hasVerifiedFindings,
  isBudgetExhausted,
  recommendNextPhase,
} from '../src/core/orchestrator/transitions.js';

describe('mission state and transitions', () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  function makeState(overrides: Partial<MissionState> = {}): MissionState {
    const now = new Date().toISOString();
    const state: MissionState = {
      budget: {
        maxTokens: 10_000,
        maxToolCalls: 100,
        tokensUsed: 0,
        toolCallsUsed: 0,
      },
      completedActions: [],
      confidence: 0,
      currentPhase: 'OBSERVE',
      hypotheses: [],
      lastTransitionAt: now,
      missionId: 'mission01',
      objectives: [
        {
          constraints: [],
          description: 'Audit target for security vulnerabilities',
          objectiveId: 'objective01',
          priority: 'high',
          scope: {
            excludePaths: [],
            includePaths: ['src'],
            targetTypes: ['typescript'],
          },
          status: 'pending',
        },
      ],
      pendingActions: [],
      phaseHistory: [
        {
          phase: 'OBSERVE',
          reason: 'evidence_collected',
          timestamp: now,
        },
      ],
      startedAt: now,
    };

    return missionStateSchema.parse({ ...state, ...overrides });
  }

  describe('mission-state core helpers', () => {
    it('validates a complete mission state shape', () => {
      const parsed = missionStateSchema.safeParse(makeState());
      expect(parsed.success).to.equal(true);
    });

    it('enforces valid phase transitions', () => {
      expect(isValidTransition('OBSERVE', 'ORIENT')).to.equal(true);
      expect(isValidTransition('OBSERVE', 'ACT')).to.equal(false);
      expect(isValidTransition('REPORT', 'COMPLETE')).to.equal(true);
    });

    it('returns allowed transitions per phase', () => {
      expect(getAllowedTransitions('VERIFY')).to.include.members(['ORIENT', 'REPORT', 'ACT', 'FAILED']);
    });

    it('detects terminal phases and tool-execution phases', () => {
      expect(isTerminalPhase('COMPLETE')).to.equal(true);
      expect(isTerminalPhase('FAILED')).to.equal(true);
      expect(isTerminalPhase('OBSERVE')).to.equal(false);

      expect(phaseAllowsToolExecution('OBSERVE')).to.equal(true);
      expect(phaseAllowsToolExecution('ACT')).to.equal(true);
      expect(phaseAllowsToolExecution('DECIDE')).to.equal(false);
    });
  });

  describe('transition engine', () => {
    it('applies valid transitions and updates history', () => {
      const state = makeState();
      const result = attemptTransition(state, 'ORIENT', 'evidence_collected');

      expect(result.ok).to.equal(true);
      if (!result.ok) return;

      expect(result.value.newState.currentPhase).to.equal('ORIENT');
      expect(result.value.newState.phaseHistory).to.have.length(2);
      expect(result.value.newState.lastTransitionReason).to.equal('evidence_collected');
      expect(result.value.events).to.have.length(1);
      expect(result.value.events[0].type).to.equal('state_transition');
    });

    it('rejects invalid transitions', () => {
      const state = makeState({ currentPhase: 'OBSERVE' });
      const result = attemptTransition(state, 'ACT', 'action_selected');
      expect(result.ok).to.equal(false);
    });

    it('tracks completed action and token usage from context', () => {
      const state = makeState({
        currentPhase: 'DECIDE',
        pendingActions: [
          {
            actionId: 'action001',
            parameters: { path: 'src/index.ts' },
            priority: 1,
            rationale: 'Inspect critical auth path',
            toolName: 'rg',
          },
        ],
      });

      const result = attemptTransition(state, 'ACT', 'action_selected', {
        completedActionId: 'action001',
        tokensUsed: 250,
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;

      expect(result.value.newState.completedActions).to.include('action001');
      expect(result.value.newState.pendingActions).to.have.length(0);
      expect(result.value.newState.budget.tokensUsed).to.equal(250);
    });
  });

  describe('budget and decision helpers', () => {
    it('marks budget exhausted when token or tool-call limits are hit', () => {
      expect(
        isBudgetExhausted({
          maxTokens: 1000,
          maxToolCalls: 10,
          tokensUsed: 1000,
          toolCallsUsed: 2,
        }),
      ).to.equal(true);

      expect(
        isBudgetExhausted({
          maxTokens: 1000,
          maxToolCalls: 10,
          tokensUsed: 500,
          toolCallsUsed: 10,
        }),
      ).to.equal(true);
    });

    it('recommends ACT in DECIDE phase when pending actions exist and budget allows', () => {
      const state = makeState({
        currentPhase: 'DECIDE',
        pendingActions: [
          {
            actionId: 'action002',
            parameters: { pattern: String.raw`exec\(` },
            priority: 2,
            rationale: 'Search for risky process execution paths',
            toolName: 'rg',
          },
        ],
      });

      const recommendation = recommendNextPhase(state);
      expect(recommendation).to.not.equal(null);
      expect(recommendation?.phase).to.equal('ACT');
      expect(recommendation?.reason).to.equal('action_selected');
    });

    it('recommends COMPLETE after REPORT phase', () => {
      const state = makeState({ currentPhase: 'REPORT' });
      const recommendation = recommendNextPhase(state);
      expect(recommendation?.phase).to.equal('COMPLETE');
      expect(recommendation?.reason).to.equal('report_generated');
    });

    it('reports verified findings and computes mission confidence from verified hypotheses only', () => {
      const now = new Date().toISOString();
      const state = makeState({
        hypotheses: [
          {
            confidence: 0.9,
            createdAt: now,
            description: 'Verified SQL injection chain',
            evidenceIds: ['evidence1'],
            hypothesisId: 'hypo0001',
            status: 'verified',
            type: 'injection',
            updatedAt: now,
          },
          {
            confidence: 0.7,
            createdAt: now,
            description: 'Verified XSS path',
            evidenceIds: ['evidence2'],
            hypothesisId: 'hypo0002',
            status: 'verified',
            type: 'xss',
            updatedAt: now,
          },
          {
            confidence: 0.95,
            createdAt: now,
            description: 'Unverified hypothesis should not influence score',
            evidenceIds: ['evidence3'],
            hypothesisId: 'hypo0003',
            status: 'investigating',
            type: 'other',
            updatedAt: now,
          },
        ],
      });

      expect(hasVerifiedFindings(state)).to.equal(true);
      expect(calculateMissionConfidence(state)).to.equal(0.8);
    });

    it('limits allowed transitions when budget is exhausted', () => {
      const state = makeState({
        budget: {
          maxTokens: 100,
          maxToolCalls: 10,
          tokensUsed: 100,
          toolCallsUsed: 1,
        },
        currentPhase: 'DECIDE',
        pendingActions: [
          {
            actionId: 'action003',
            parameters: {},
            priority: 1,
            rationale: 'Would normally run',
            toolName: 'rg',
          },
        ],
      });

      const allowed = getAllowedTransitionsForState(state);
      expect(allowed).to.not.include('ACT');
      expect(allowed).to.include('FAILED');
    });
  });
});
