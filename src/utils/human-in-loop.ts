/**
 * Human-in-the-Loop utilities for agentic tool confirmations.
 *
 * Uses LangGraph's native `Command` interrupt pattern instead of blocking
 * Promises. When a tool needs confirmation, it throws a `Command` that sets
 * `pendingHumanInput` state and routes the graph to the `HumanIntervention`
 * node (declared as `interruptBefore` in the compile call). The graph pauses,
 * checkpointing state. The TUI detects the pause, shows the question, and
 * when the user responds, the graph is resumed with the human's answer
 * injected as a `HumanMessage`.
 *
 * After resume, the session supplies an explicit approve/deny decision. The
 * same tool is called again and consumes that decision before continuing.
 *
 * For non-LangGraph paths, the Command throw is caught and the function falls
 * back to the blocking confirmation pattern.
 *
 * ## Timeout
 * A configurable timeout (default: 5 minutes) auto-denies unanswered
 * confirmation requests so the analysis doesn't stall indefinitely.
 *
 * ## HumanInteractionService
 * All mutable state is encapsulated in the `HumanInteractionService` class.
 * Each `AgentSession` can create/inject its own instance for isolation.
 * Legacy module-level functions are kept as deprecated re-exports that
 * delegate to a shared default instance.
 */

import { Command } from '@langchain/langgraph';
import { createHash } from 'node:crypto';

import type {
  PatchReviewDecision,
  PatchReviewRequest,
} from '../core/remediation/types.js';

/** Default timeout for human input requests (5 minutes). */
const DEFAULT_HUMAN_INPUT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Encapsulates all human-in-the-loop mutable state and confirmation logic.
 *
 * Each `AgentSession` should create its own instance so that pending
 * signatures, decisions, and timeout timers are isolated per session
 * — preventing stale state from leaking across sessions in the same process.
 *
 * @example
 * ```ts
 * const hil = new HumanInteractionService();
 * hil.enableLangGraphContext();
 * // ... run workflow ...
 * hil.reset(); // clean up on session end
 * ```
 */
export class HumanInteractionService {
/**
 * Controls whether to throw a LangGraph Command (LangGraph context) or
 * fall back to a blocking Promise.
 * Set to `true` by the LangGraph workflow on initialization.
 */
  private langGraphContext = false;
  /** Explicit decision supplied by the session when a paused graph resumes. */
  private pendingDecision: boolean | null = null;
  private pendingDecisionSource: 'timeout' | 'user' | null = null;
/**
 * Tracks the signature of the currently pending confirmation request.
 */
  private pendingSignature: null | string = null;
/** Current timeout timer handle, cleared on response. */
  private timeoutTimer: null | ReturnType<typeof setTimeout> = null;

  /**
   * Request human confirmation before executing a command.
   * Throws a Command (LangGraph) or returns a blocking result.
   */
  async confirmCommandExecution(command: string, warning?: string): Promise<boolean> {
    return this.requestConfirmation({
      context: warning ? `Warning: ${warning}` : undefined,
      message: `Allow execution of command: ${command}?`,
      title: 'PROPOSED COMMAND EXECUTION',
    });
  }

  /**
   * Request human confirmation before applying a file edit.
   * Throws a Command (LangGraph) or returns a blocking result.
   */
  async confirmFileEdit(
    filePath: string,
    targetCode: string,
    replacementCode: string,
  ): Promise<boolean> {
    return this.requestConfirmation({
      context: `Remove:\n${targetCode}\n\nAdd:\n${replacementCode}`,
      message: `Allow editing file: ${filePath}?`,
      title: 'PROPOSED FILE EDIT',
    });
  }

  /**
   * Request human confirmation before executing an MCP tool.
   * Throws a Command (LangGraph) or returns a blocking result.
   */
  async confirmMcpToolExecution(
    adapterName: string,
    toolName: string,
    payload: unknown,
    warning?: string,
  ): Promise<boolean> {
    return this.requestConfirmation({
      context: warning
        ? `Warning: ${warning}\n\nInput: ${JSON.stringify(payload, null, 2)}`
        : `Input: ${JSON.stringify(payload, null, 2)}`,
      message: `Allow MCP tool execution: ${adapterName}.${toolName}?`,
      title: 'MCP TOOL EXECUTION',
    });
  }

  async confirmPatchApplication(findingId: string, diff: string): Promise<boolean> {
    return this.requestConfirmation({
      context: `Finding: ${findingId}\n\n${diff}`,
      message: `Allow applying and testing the proposed patch for finding ${findingId}?`,
      title: 'PROPOSED SECURITY PATCH',
    });
  }

  /** Disable LangGraph context (revert to blocking confirmation). */
  disableLangGraphContext(): void {
    this.langGraphContext = false;
  }

  /** Enable LangGraph Command-based confirmation (called by graph bootstrap). */
  enableLangGraphContext(): void {
    this.langGraphContext = true;
  }

  /**
   * Blocking confirmation for execution paths outside a compiled StateGraph.
   */
  async requestBlockingConfirmation(params: {
    context?: string;
    message: string;
    title: string;
  }): Promise<boolean> {
    const { useAppStore } = await import('../ui/store/appStore.js');
    return new Promise((resolve) => {
      useAppStore.getState().requestConfirmation({
        ...params,
        onConfirm: (confirmed: boolean) => resolve(confirmed),
      });
    });
  }

  /**
   * Reset all instance state. Must be called when a new AgentSession is
   * initialized to prevent stale signatures from a previous session (in the
   * same process) from incorrectly matching confirmation requests.
   */
  reset(): void {
    this.pendingSignature = null;
    this.pendingDecision = null;
    this.pendingDecisionSource = null;
    this.langGraphContext = false;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * Supply the user's decision for the currently pending request.
   * Returns false when there is no request to resolve, preventing stale or
   * duplicate resume messages from authorizing a future operation.
   */
  resolvePendingDecision(approved: boolean, requestId?: string): boolean {
    if (!this.pendingSignature) {
      if (!requestId) return false;
      this.pendingSignature = requestId;
      this.pendingDecision = null;
      this.pendingDecisionSource = null;
    } else if (requestId && this.pendingSignature !== requestId) {
      return false;
    }

    // A timeout preloads an explicit denial. Accepting the same denial lets the
    // UI resume the checkpoint through the normal rejection path.
    if (this.pendingDecision !== null) {
      if (this.pendingDecisionSource === 'timeout' && this.pendingDecision === approved) {
        this.pendingDecisionSource = 'user';
        return true;
      }

      return false;
    }

    this.pendingDecision = approved;
    this.pendingDecisionSource = 'user';
    this.clearTimeout();
    return true;
  }

  async reviewValidatedPatch(request: PatchReviewRequest): Promise<PatchReviewDecision> {
    const { useAppStore } = await import('../ui/store/appStore.js');
    const testSummary = request.testResult.newFailures.length === 0
      ? `Validation passed in ${request.testResult.durationMs}ms with no new failures.`
      : `Validation found ${request.testResult.newFailures.length} new failure(s).`;

    return new Promise<PatchReviewDecision>((resolve) => {
      let settled = false;
      const finish = (decision: PatchReviewDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(decision);
      };

      const timeout = setTimeout(() => {
        useAppStore.getState().closeConfirmation();
        finish({ action: 'reject' });
      }, DEFAULT_HUMAN_INPUT_TIMEOUT_MS);
      timeout.unref?.();

      useAppStore.getState().requestChoice({
        details: request.diff,
        kind: 'patch',
        message: `${testSummary}\nFinding: ${request.findingId}`,
        onSelect(action) {
          if (action !== 'revise') {
            finish({ action: action === 'apply' ? 'apply' : 'reject' });
            return;
          }

          useAppStore.getState().requestTextInput({
            message: 'Describe the required changes. The current patch will not be applied.',
            onSubmit: (instructions) => finish({ action: 'revise', instructions }),
            placeholder: 'Use the existing validation helper instead...',
            title: 'Revise security patch',
          });
        },
        options: [
          { label: 'Apply validated patch', value: 'apply' },
          { label: 'Revise patch', value: 'revise' },
          { label: 'Reject patch', value: 'reject' },
        ],
        title: 'Review validated security patch',
      });
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /** Clear the timeout timer when the user responds. */
  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private createSignature(params: { context?: string; message: string; title: string }): string {
    return createHash('sha256')
      .update(JSON.stringify([params.title, params.message, params.context ?? null]))
      .digest('hex');
  }

  /**
   * Request human confirmation.
   *
   * - **First call**: Instance has no pending signature. Stores the signature
   *   and throws a Command (LangGraph) or falls back to blocking confirmation.
   * - **Second call (after resume)**: Signature matches and consumes the
   *   explicit decision supplied by the session.
   *
   * @returns The explicit decision on a resumed call. The first LangGraph call
   *          throws a Command. Non-LangGraph paths return a blocking result.
   */
  private async requestConfirmation(params: {
    context?: string;
    message: string;
    title: string;
  }): Promise<boolean> {
    const sig = this.createSignature(params);

    // Second call after resume — consume the explicit human decision.
    if (this.pendingSignature === sig && this.pendingDecision !== null) {
      const approved = this.pendingDecision;
      this.pendingSignature = null;
      this.pendingDecision = null;
      this.pendingDecisionSource = null;
      this.clearTimeout();
      return approved;
    }

    if (this.pendingSignature && this.pendingSignature !== sig) {
      throw new Error('Another human confirmation request is already pending.');
    }

    // First call — store the signature for resume detection.
    this.pendingSignature = sig;
    this.pendingDecision = null;
    this.pendingDecisionSource = null;

    // Start auto-deny timeout
    this.startTimeout(sig);

    if (this.langGraphContext) {
      // LangGraph context: throw a Command. The graph runtime intercepts this,
      // applies the state update, and pauses at HumanIntervention.
      throw new Command({
        goto: ['HumanIntervention'],
        update: {
          pendingHumanInput: {
            context: params.context,
            question: params.message,
            requestId: sig,
            type: 'confirmation' as const,
          },
        },
      });
    }

    // Non-LangGraph path: use blocking confirmation.
    const confirmed = await this.requestBlockingConfirmation(params);
    this.pendingSignature = null;
    this.pendingDecision = null;
    this.pendingDecisionSource = null;
    this.clearTimeout();
    return confirmed;
  }

  /**
   * Start the auto-deny timeout. If the user doesn't respond within the
   * timeout period, the pending request is auto-denied via the store.
   */
  private startTimeout(signature: string): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    this.timeoutTimer = setTimeout(async () => {
      // Only fire if the pending signature still matches (hasn't been cleared
      // by a user response).
      if (this.pendingSignature !== signature) return;

      this.pendingDecision = false;
      this.pendingDecisionSource = 'timeout';
      this.timeoutTimer = null;

      // Auto-deny via the Zustand store
      try {
        const { useAppStore } = await import('../ui/store/appStore.js');
        const store = useAppStore.getState();
        if (store.confirmation.open) {
          store.confirmation.onConfirm(false);
          store.closeConfirmation();
        }

        // Keep LangGraph's request visible. The next denial submission resumes
        // the checkpoint and consumes the timeout decision rather than hiding
        // a graph that is still suspended.
      } catch {
        // Store may not be available in all contexts (e.g., tests)
      }
    }, DEFAULT_HUMAN_INPUT_TIMEOUT_MS);
    this.timeoutTimer.unref?.();
  }
}

// ─── Deprecated backward-compatible module-level exports ─────────────────
// These delegate to a shared default instance to minimize breakage for
// existing importers. New code should create/inject its own
// HumanInteractionService instance instead.
// ──────────────────────────────────────────────────────────────────────────

/** @deprecated Use `HumanInteractionService` instance instead. */
const defaultInstance = new HumanInteractionService();

/** @deprecated Use `HumanInteractionService.enableLangGraphContext()` instead. */
export function enableLangGraphContext(): void {
  defaultInstance.enableLangGraphContext();
}

/** @deprecated Use `HumanInteractionService.disableLangGraphContext()` instead. */
export function disableLangGraphContext(): void {
  defaultInstance.disableLangGraphContext();
}

/** @deprecated Use `HumanInteractionService.reset()` instead. */
export function resetHumanInLoopState(): void {
  defaultInstance.reset();
}

/** @deprecated Use `HumanInteractionService.confirmFileEdit()` instead. */
export async function confirmFileEdit(
  filePath: string,
  targetCode: string,
  replacementCode: string,
): Promise<boolean> {
  return defaultInstance.confirmFileEdit(filePath, targetCode, replacementCode);
}

/** @deprecated Use `HumanInteractionService.confirmCommandExecution()` instead. */
export async function confirmCommandExecution(command: string, warning?: string): Promise<boolean> {
  return defaultInstance.confirmCommandExecution(command, warning);
}

/** @deprecated Use `HumanInteractionService.confirmMcpToolExecution()` instead. */
export async function confirmMcpToolExecution(
  adapterName: string,
  toolName: string,
  payload: unknown,
  warning?: string,
): Promise<boolean> {
  return defaultInstance.confirmMcpToolExecution(adapterName, toolName, payload, warning);
}

/** @deprecated Use `HumanInteractionService.requestBlockingConfirmation()` instead. */
export async function requestBlockingConfirmation(params: {
  context?: string;
  message: string;
  title: string;
}): Promise<boolean> {
  return defaultInstance.requestBlockingConfirmation(params);
}
