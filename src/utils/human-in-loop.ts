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
 */

import { Command } from '@langchain/langgraph';

/**
 * Tracks the signature of the currently pending confirmation request.
 * When the graph pauses and resumes, the same tool runs again, sees this
 * signature matches, and returns `true` (confirmed) instead of re-throwing.
 *
 * A different confirmation request (different title/message) will NOT match,
 * so if the human denies one confirmation and the supervisor calls a
 * different tool requiring confirmation, it will correctly request again.
 */
let _pendingSignature: string | null = null;

/**
 * Controls whether to throw a LangGraph Command (LangGraph context) or
 * fall back to a blocking Promise (Vercel AI SDK / swarm mode).
 * Set to `true` by the LangGraph workflow on initialization.
 */
let _langGraphContext = false;

/** Enable LangGraph Command-based confirmation (called by graph bootstrap). */
export function enableLangGraphContext(): void {
  _langGraphContext = true;
}

/** Disable LangGraph context (revert to blocking confirmation). */
export function disableLangGraphContext(): void {
  _langGraphContext = false;
}

function createSignature(params: { title: string; message: string }): string {
  return `${params.title}||${params.message}`;
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
    return true;
  }

  // First call — store the signature for resume detection.
  _pendingSignature = sig;

  if (_langGraphContext) {
    // LangGraph context: throw a Command. The graph runtime intercepts this,
    // applies the state update, and pauses at HumanIntervention.
    throw new Command({
      update: {
        pendingHumanInput: {
          context: params.context,
          question: params.message,
          type: 'confirmation' as const,
        },
      },
      goto: ['HumanIntervention'],
    });
  }

  // Non-LangGraph path (Vercel AI SDK / swarm mode): use blocking confirmation.
  // Fall through to the blocking implementation since Command throws are not
  // handled outside of LangGraph.
  const confirmed = await requestBlockingConfirmation(params);
  _pendingSignature = null;
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
