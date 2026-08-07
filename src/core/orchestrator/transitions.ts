/**
 * Mission Transitions - State transition logic and validation.
 */

import type { EventStore } from '../memory/event-store.js';

import { err, ok, type Result } from '../schema/base.js';
import {
  type BudgetState,
  type Hypothesis,
  isTerminalPhase,
  isValidTransition,
  type MissionPhase,
  type MissionState,
  type PendingAction,
  type TransitionReason,
} from './mission-state.js';

export interface TransitionContext {
  completedActionId?: string;
  error?: Error;
  evidenceCollected?: boolean;
  hypothesesUpdated?: Hypothesis[];
  newActions?: PendingAction[];
  tokensUsed?: number;
  verificationPassed?: boolean;
}

export interface TransitionResult {
  events: Array<{ payload: Record<string, unknown>; type: string }>;
  newState: MissionState;
}

/**
 * Attempt a state transition with validation.
 */
export function attemptTransition(
  currentState: MissionState,
  targetPhase: MissionPhase,
  reason: TransitionReason,
  context: TransitionContext = {},
): Result<TransitionResult, string> {
  // Validate transition is allowed
  if (!isValidTransition(currentState.currentPhase, targetPhase)) {
    return err(
      `Invalid transition: ${currentState.currentPhase} → ${targetPhase}. ` +
        `Allowed: ${getAllowedTransitionsForState(currentState).join(', ')}`,
    );
  }

  // Validate terminal state isn't being left
  if (isTerminalPhase(currentState.currentPhase)) {
    return err(`Cannot transition from terminal state: ${currentState.currentPhase}`);
  }

  const now = new Date().toISOString();
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];

  // Build new state
  let newState: MissionState = {
    ...currentState,
    currentPhase: targetPhase,
    lastTransitionAt: now,
    lastTransitionReason: reason,
    phaseHistory: [
      ...currentState.phaseHistory,
      {
        phase: targetPhase,
        reason,
        timestamp: now,
      },
    ],
  };

  // Apply context-specific updates
  if (context.tokensUsed !== undefined) {
    newState = {
      ...newState,
      budget: {
        ...newState.budget,
        tokensUsed: newState.budget.tokensUsed + context.tokensUsed,
      },
    };
  }

  if (context.completedActionId) {
    newState = {
      ...newState,
      completedActions: [...newState.completedActions, context.completedActionId],
      pendingActions: newState.pendingActions.filter((a) => a.actionId !== context.completedActionId),
    };
  }

  if (context.newActions) {
    newState = {
      ...newState,
      pendingActions: [...newState.pendingActions, ...context.newActions],
    };
  }

  if (context.hypothesesUpdated) {
    // Merge updated hypotheses
    const hypothesesMap = new Map(newState.hypotheses.map((h) => [h.hypothesisId, h]));
    for (const updated of context.hypothesesUpdated) {
      hypothesesMap.set(updated.hypothesisId, updated);
    }

    newState = {
      ...newState,
      hypotheses: [...hypothesesMap.values()],
    };
  }

  if (context.error) {
    newState = {
      ...newState,
      errorMessage: context.error.message,
    };
  }

  // Record transition event
  events.push({
    payload: {
      context,
      from: currentState.currentPhase,
      missionId: currentState.missionId,
      reason,
      to: targetPhase,
    },
    type: 'state_transition',
  });

  return ok({ events, newState });
}

/**
 * Get allowed transitions for current state considering budget and other constraints.
 */
export function getAllowedTransitionsForState(state: MissionState): MissionPhase[] {
  const { currentPhase } = state;

  // Basic valid transitions
  const allowed: MissionPhase[] = [];

  // Check budget constraints
  const budgetExhausted = isBudgetExhausted(state.budget);

  switch (currentPhase) {
    case 'ACT': {
      allowed.push('VERIFY', 'OBSERVE'); // Direct to observe for more data
      break;
    }

    case 'DECIDE': {
      if (!budgetExhausted && state.pendingActions.length > 0) {
        allowed.push('ACT');
      }

      if (hasVerifiedFindings(state)) {
        allowed.push('REPORT');
      }

      allowed.push('OBSERVE'); // Loop back
      break;
    }

    case 'OBSERVE': {
      allowed.push('ORIENT');
      if (budgetExhausted) {
        allowed.push('FAILED');
      }

      break;
    }

    case 'ORIENT': {
      allowed.push('DECIDE', 'OBSERVE'); // Loop back for more data
      break;
    }

    case 'REPORT': {
      allowed.push('COMPLETE');
      if (!budgetExhausted) {
        allowed.push('OBSERVE'); // Continue analysis
      }

      break;
    }

    case 'VERIFY': {
      allowed.push('ORIENT'); // Update hypotheses
      if (hasVerifiedFindings(state)) {
        allowed.push('REPORT');
      }

      if (state.pendingActions.length > 0 && !budgetExhausted) {
        allowed.push('ACT'); // Continue with more actions
      }

      break;
    }
  }

  // FAILED is always available from non-terminal states
  if (!isTerminalPhase(currentPhase) && !allowed.includes('FAILED')) {
    allowed.push('FAILED');
  }

  return allowed;
}

/**
 * Check if budget is exhausted.
 */
export function isBudgetExhausted(budget: BudgetState): boolean {
  return (
    budget.tokensUsed >= budget.maxTokens ||
    budget.toolCallsUsed >= budget.maxToolCalls
  );
}

/**
 * Check if state has verified findings ready for reporting.
 */
export function hasVerifiedFindings(state: MissionState): boolean {
  return state.hypotheses.some((h) => h.status === 'verified' && h.confidence >= 0.7);
}

/**
 * Determine recommended next phase based on current state.
 */
export function recommendNextPhase(state: MissionState): null | {
  phase: MissionPhase;
  reason: TransitionReason;
} {
  const allowed = getAllowedTransitionsForState(state);
  if (allowed.length === 0) {
    return null;
  }

  const { currentPhase } = state;
  const budgetExhausted = isBudgetExhausted(state.budget);

  // Priority-based recommendations
  switch (currentPhase) {
    case 'ACT': {
      return { phase: 'VERIFY', reason: 'action_executed' };
    }

    case 'DECIDE': {
      if (state.pendingActions.length > 0 && !budgetExhausted) {
        return { phase: 'ACT', reason: 'action_selected' };
      }

      if (hasVerifiedFindings(state)) {
        return { phase: 'REPORT', reason: 'confidence_threshold_reached' };
      }

      return { phase: 'OBSERVE', reason: 'evidence_collected' };
    }

    case 'OBSERVE': {
      return { phase: 'ORIENT', reason: 'evidence_collected' };
    }

    case 'ORIENT': {
      if (state.hypotheses.length > 0) {
        return { phase: 'DECIDE', reason: 'hypotheses_formed' };
      }

      return { phase: 'OBSERVE', reason: 'evidence_collected' };
    }

    case 'REPORT': {
      return { phase: 'COMPLETE', reason: 'report_generated' };
    }

    case 'VERIFY': {
      if (hasVerifiedFindings(state) && budgetExhausted) {
        return { phase: 'REPORT', reason: 'budget_exhausted' };
      }

      return { phase: 'ORIENT', reason: 'evidence_collected' };
    }
  }

  return null;
}

/**
 * Calculate overall mission confidence from hypotheses.
 */
export function calculateMissionConfidence(state: MissionState): number {
  const verified = state.hypotheses.filter((h) => h.status === 'verified');
  if (verified.length === 0) {
    return 0;
  }

  // Average confidence of verified hypotheses
  const sum = verified.reduce((acc, h) => acc + h.confidence, 0);
  return sum / verified.length;
}
