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
 * After resume, the same tool is called again. The confirmation function
 * detects this via a signature-based tracking mechanism and returns `true`
 * (confirmed) instead of throwing again, allowing the tool's execution code
 * after the await to be reached.
 *
 * For non-LangGraph paths (Vercel AI SDK/swarm mode), the Command throw is
 * caught and the function falls back to the blocking confirmation pattern.
 *
 * ## Decision History
 * Successful confirmations are tracked in a decision history. When the same
 * type of operation is requested again on the same file, the confirmation
 * is auto-approved — reducing interruption fatigue during long sessions.
 *
 * ## Timeout
 * A configurable timeout (default: 5 minutes) auto-denies unanswered
 * confirmation requests so the analysis doesn't stall indefinitely.
 */

import { Command } from '@langchain/langgraph';

/**
 * Tracks the signature of the currently pending confirmation request.
 * When the graph pauses and resumes, the same tool runs again, sees this
 * signature matches, and returns `true` (confirmed) instead of re-throwing.
 */
let _pendingSignature: null | string = null;

/**
 * Controls whether to throw a LangGraph Command (LangGraph context) or
 * fall back to a blocking Promise (Vercel AI SDK / swarm mode).
 * Set to `true` by the LangGraph workflow on initialization.
 */
let _langGraphContext = false;

/**
 * Decision history: tracks previously approved operations so similar
 * future operations can be auto-approved. Keyed by operation type + file.
 * Max 50 entries to prevent unbounded memory growth.
 */
const _decisionHistory = new Map<string, { approved: boolean; timestamp: number }>();
const MAX_DECISION_HISTORY = 50;

/**
 * Default timeout for human input requests (5 minutes).
 * After this duration, unanswered requests are auto-denied.
 */
const DEFAULT_HUMAN_INPUT_TIMEOUT_MS = 5 * 60 * 1000;

/** Current timeout timer handle, cleared on response. */
let _timeoutTimer: ReturnType<typeof setTimeout> | null = null;

/** Enable LangGraph Command-based confirmation (called by graph bootstrap). */
export function enableLangGraphContext(): void {
  _langGraphContext = true;
}

/** Disable LangGraph context (revert to blocking confirmation). */
export function disableLangGraphContext(): void {
  _langGraphContext = false;
}

/**
 * Reset all module-level state. Must be called when a new AgentSession is
 * initialized to prevent stale signatures from a previous session (in the
 * same process) from incorrectly matching confirmation requests.
 */
export function resetHumanInLoopState(): void {
  _pendingSignature = null;
  _langGraphContext = false;
  _decisionHistory.clear();
  if (_timeoutTimer) {
    clearTimeout(_timeoutTimer);
    _timeoutTimer = null;
  }
}

function createSignature(params: { message: string; title: string }): string {
  return `${params.title}||${params.message}`;
}

/**
 * Check decision history for a matching previous approval.
 * Returns true if the same operation on the same file was previously approved
 * within the last hour.
 */
function checkDecisionHistory(signature: string): boolean {
  const entry = _decisionHistory.get(signature);
  if (!entry || !entry.approved) return false;

  // Only auto-approve decisions made within the last hour
  const oneHour = 60 * 60 * 1000;
  if (Date.now() - entry.timestamp > oneHour) {
    _decisionHistory.delete(signature);
    return false;
  }

  return true;
}

/**
 * Record a decision in the history for future auto-approval.
 */
function recordDecision(signature: string, approved: boolean): void {
  // Prune if over limit
  if (_decisionHistory.size >= MAX_DECISION_HISTORY) {
    const oldest = [..._decisionHistory.entries()]
      .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0];
    if (oldest) _decisionHistory.delete(oldest[0]);
  }

  _decisionHistory.set(signature, { approved, timestamp: Date.now() });
}

/**
 * Start the auto-deny timeout. If the user doesn't respond within the
 * timeout period, the pending request is auto-denied via the store.
 */
function startTimeout(signature: string): void {
  if (_timeoutTimer) clearTimeout(_timeoutTimer);

  _timeoutTimer = setTimeout(async () => {
    // Only fire if the pending signature still matches (hasn't been cleared
    // by a user response).
    if (_pendingSignature !== signature) return;

    _pendingSignature = null;
    _timeoutTimer = null;

    // Auto-deny via the Zustand store
    try {
      const { useAppStore } = await import('../ui/store/appStore.js');
      const store = useAppStore.getState();
      if (store.confirmation.open) {
        store.confirmation.onConfirm(false);
        store.closeConfirmation();
      }
      if (store.humanInputRequest) {
        store.setHumanInputRequest(null);
      }
    } catch {
      // Store may not be available in all contexts (e.g., tests)
    }
  }, DEFAULT_HUMAN_INPUT_TIMEOUT_MS);
}

/**
 * Clear the timeout timer when the user responds.
 */
function clearTimeout_(): void {
  if (_timeoutTimer) {
    clearTimeout(_timeoutTimer);
    _timeoutTimer = null;
  }
}

/**
 * Request human confirmation.
 *
 * - **First call**: Module has no pending signature. Stores the signature
 *   and throws a Command (LangGraph) or falls back to blocking (Vercel AI SDK).
 * - **Second call (after resume)**: Signature matches. Returns `true` so the
 *   tool proceeds with execution. The signature is cleared.
 *
 * @returns `true` if confirmed (resumed call), never returns normally on first
 *          LangGraph call (throws Command). For non-LangGraph paths, returns
 *          the blocking confirmation result.
 */
async function requestConfirmation(params: {
  context?: string;
  message: string;
  title: string;
}): Promise<boolean> {
  const sig = createSignature(params);

  // Second call after resume — the human already approved this confirmation.
  // Return true so the caller proceeds with execution.
  if (_pendingSignature === sig) {
    _pendingSignature = null;
    clearTimeout_();
    recordDecision(sig, true);
    return true;
  }

  // Check decision history: if the same operation was approved recently,
  // auto-approve without interrupting the user.
  if (checkDecisionHistory(sig)) {
    return true;
  }

  // First call — store the signature for resume detection.
  _pendingSignature = sig;

  // Start auto-deny timeout
  startTimeout(sig);

  if (_langGraphContext) {
    // LangGraph context: throw a Command. The graph runtime intercepts this,
    // applies the state update, and pauses at HumanIntervention.
    throw new Command({
      goto: ['HumanIntervention'],
      update: {
        pendingHumanInput: {
          context: params.context,
          question: params.message,
          type: 'confirmation' as const,
        },
      },
    });
  }

  // Non-LangGraph path (Vercel AI SDK / swarm mode): use blocking confirmation.
  const confirmed = await requestBlockingConfirmation(params);
  _pendingSignature = null;
  clearTimeout_();
  recordDecision(sig, confirmed);
  return confirmed;
}

/**
 * Request human confirmation before applying a file edit.
 * Throws a Command (LangGraph) or returns blocking result (Vercel AI SDK).
 */
export async function confirmFileEdit(
  filePath: string,
  targetCode: string,
  replacementCode: string,
): Promise<boolean> {
  return requestConfirmation({
    context: `Remove:\n${targetCode}\n\nAdd:\n${replacementCode}`,
    message: `Allow editing file: ${filePath}?`,
    title: 'PROPOSED FILE EDIT',
  });
}

/**
 * Request human confirmation before executing a command.
 * Throws a Command (LangGraph) or returns blocking result (Vercel AI SDK).
 */
export async function confirmCommandExecution(command: string, warning?: string): Promise<boolean> {
  return requestConfirmation({
    context: warning ? `Warning: ${warning}` : undefined,
    message: `Allow execution of command: ${command}?`,
    title: 'PROPOSED COMMAND EXECUTION',
  });
}

/**
 * Request human confirmation before executing an MCP tool.
 * Throws a Command (LangGraph) or returns blocking result (Vercel AI SDK).
 */
export async function confirmMcpToolExecution(
  adapterName: string,
  toolName: string,
  payload: unknown,
  warning?: string,
): Promise<boolean> {
  return requestConfirmation({
    context: warning
      ? `Warning: ${warning}\n\nInput: ${JSON.stringify(payload, null, 2)}`
      : `Input: ${JSON.stringify(payload, null, 2)}`,
    message: `Allow MCP tool execution: ${adapterName}.${toolName}?`,
    title: 'MCP TOOL EXECUTION',
  });
}

/**
 * Legacy blocking confirmation for the Vercel AI SDK streamText flow
 * (non-LangGraph paths). This is kept as a fallback for the swarm coordinator
 * which uses the Vercel AI SDK's streamText, not LangGraph's StateGraph.
 * The blocking Promise pattern works fine there because streamText handles
 * concurrent tool execution differently.
 */
export async function requestBlockingConfirmation(params: {
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
