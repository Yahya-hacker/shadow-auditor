import * as crypto from 'node:crypto';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  END,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { type ToolSet } from 'ai';
import { z } from 'zod';

import { enableLangGraphContext, resetHumanInLoopState } from '../../utils/human-in-loop.js';
import { AgentState } from './state.js';
import { ToolRetriever } from './tool-retriever.js';
import { wrapTool } from './tools/langchain-wrapper.js';

type GraphState = typeof AgentState.State;
type ToolEntry = { name: string; tool: ToolSet[string] };

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 25;

// Maximum consecutive cycles with the same state hash before we force
// termination. Detects when the LLM is stuck in a repetitive pattern
// (same tool calls, same outputs) — common with hallucinated fixes.
const MAX_REPETITIVE_CYCLES = 3;

// Sliding window: maximum messages to keep in context. Older messages
// are summarized into workingMemory to prevent context drift and token
// bloat while preserving critical findings.
const MAX_CONTEXT_MESSAGES = 40;

// When messages exceed this threshold, trigger a summarization pass
// that compresses older messages into workingMemory.
const SUMMARIZE_THRESHOLD = 30;

/**
 * Structured output schema for the Supervisor's routing decision.
 * The Supervisor produces a JSON object with the next node to execute
 * and a rationale — making multi-agent delegation real, deterministic,
 * and traceable (replaces the old static fallback to SastAnalyzer).
 */
const supervisorRoutingSchema = z.object({
  next_node: z.enum([
    'ToolExecutor',
    'SastAnalyzer',
    'GraphTracer',
    'Verifier',
    'Reflector',
    'END',
  ]).describe('The next node to execute in the analysis pipeline.'),
  rationale: z.string().describe('Why this node was chosen based on the current state.'),
});

/**
 * Compute a stable hash of the last K AI messages to detect loops.
 *
 * Hashes tool call signatures (name + JSON args) rather than text content
 * so that repetitive failing tool calls are detected even when the LLM
 * varies its monologue wording each time ("trying again...", "adjusting...").
 * Falls back to text content only when there are no tool calls (e.g. final
 * text responses).
 */
function computeStateHash(state: GraphState): string {
  const recentAI = state.messages
    .filter((m) => m instanceof AIMessage)
    .slice(-5) as AIMessage[];

  // Collect tool call signatures: tool name + stringified arguments.
  const signatures: string[] = [];
  for (const msg of recentAI) {
    // Standard LangChain tool_calls
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        signatures.push(`${tc.name}:${JSON.stringify(tc.args)}`);
      }
    }
    // Provider-specific additional_kwargs.tool_calls
    const kwargsCalls = msg.additional_kwargs?.tool_calls;
    if (Array.isArray(kwargsCalls)) {
      for (const tc of kwargsCalls as Array<{ function?: { name?: string; arguments?: string } }>) {
        const name = tc.function?.name ?? 'unknown';
        const args = tc.function?.arguments ?? '{}';
        signatures.push(`${name}:${args}`);
      }
    }
  }

  // If there are tool calls, hash only the signatures — this catches
  // infinite tool loops regardless of textual justifications. Otherwise
  // fall back to text content (e.g. for final response loops).
  const hashInput = signatures.length > 0
    ? signatures.join('|')
    : recentAI.map((m) => m.content).join('');

  return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
}

/** Track state hashes to detect loops across supersteps. */
const stateHashHistory = new Map<string, number>();

function checkRepetitiveLoop(state: GraphState): boolean {
  const hash = computeStateHash(state);
  const count = (stateHashHistory.get(hash) ?? 0) + 1;
  stateHashHistory.set(hash, count);
  return count >= MAX_REPETITIVE_CYCLES;
}

/**
 * Trim message history to the sliding window size. When messages exceed
 * SUMMARIZE_THRESHOLD, older messages are compressed into a summary that
 * is stored in workingMemory — so critical findings survive trimming.
 *
 * The structured `auditedFiles` and `discoveredFindings` arrays are preserved
 * as-is; only old text messages are compressed. This prevents the SAST agent
 * from "forgetting" which files it has already audited and entering an
 * infinite re-reading loop.
 */
function trimContext(state: GraphState): {
  messages: BaseMessage[];
  updatedMemory: string;
  auditedFiles: string[];
  discoveredFindings: string[];
} {
  const messages = state.messages;
  if (messages.length <= MAX_CONTEXT_MESSAGES) {
    return {
      messages,
      updatedMemory: state.workingMemory,
      auditedFiles: state.auditedFiles,
      discoveredFindings: state.discoveredFindings,
    };
  }

  // Keep first message (system context) + last N-1 messages
  const first = messages[0];
  const recent = messages.slice(-(MAX_CONTEXT_MESSAGES - 1));
  const dropped = messages.slice(1, -(MAX_CONTEXT_MESSAGES - 1));

  // Summarize dropped messages, using structured state as authoritative source
  const summary = summarizeDroppedMessages(dropped, state.auditedFiles);
  const updatedMemory = state.workingMemory
    ? `${state.workingMemory}\n\n[Auto-summarized earlier context]:\n${summary}`
    : `[Auto-summarized earlier context]:\n${summary}`;

  // Structured state survives trimming intact
  return {
    messages: [first!, ...recent],
    updatedMemory,
    auditedFiles: state.auditedFiles,
    discoveredFindings: state.discoveredFindings,
  };
}

/**
 * Compress dropped messages into a concise summary for working memory.
 *
 * Uses the structured `auditedFiles` from state as the authoritative source
 * for file tracking — the old regex-only approach was fragile against LLM
 * formatting variations (markdown tables, different emoji, etc.). The regex
 * is now only a fallback when structured state is not available.
 */
function summarizeDroppedMessages(
  messages: BaseMessage[],
  auditedFiles: string[] = [],
): string {
  const findings: string[] = [];
  const filesExamined = new Set<string>(auditedFiles); // Start from authoritative state
  const toolCalls: string[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Fallback regex extraction for files — complements the structured state
    const fileMatches = content.match(/(?:File:|📄|📁|FILE:)\s*([^\s,\n]+)/gi);
    if (fileMatches) {
      for (const m of fileMatches) {
        const cleaned = m.replace(/(?:File:|📄|📁|FILE:)\s*/i, '').trim();
        if (cleaned.length > 2 && cleaned.length < 200) filesExamined.add(cleaned);
      }
    }

    // Also try generic file path patterns as additional fallback
    const genericFiles = content.match(/(?:`|['"]|\b)([\w./-]+\.(?:ts|tsx|js|jsx|py|go|java|rs|php|rb|c|h|cpp|cxx|hpp|vue|svelte|swift|kt|kts|sql|yaml|yml|json|xml|toml)(?:`|['"]|\b))/gi);
    if (genericFiles) {
      for (const f of genericFiles) {
        const cleaned = f.replace(/[`'"]/g, '').trim();
        if (cleaned.length > 2 && cleaned.length < 200) filesExamined.add(cleaned);
      }
    }

    // Extract findings and hypotheses
    if (content.includes('[Hit]') || content.includes('[Alert]') || content.includes('vulnerability') ||
        content.includes('CWE-') || content.includes('finding') || content.includes('injection')) {
      // Take first 200 chars as a summary snippet
      const snippet = content.replace(/\n/g, ' ').slice(0, 200).trim();
      findings.push(`- ${snippet}...`);
    }

    // Track tool usage
    if (msg instanceof AIMessage && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        toolCalls.push(tc.name);
      }
    }
  }

  const parts: string[] = [];
  if (filesExamined.size > 0) {
    parts.push(`Files examined: ${[...filesExamined].slice(0, 15).join(', ')}${filesExamined.size > 15 ? ` (+${filesExamined.size - 15} more)` : ''}`);
  }
  if (findings.length > 0) {
    parts.push(`Key findings/hypotheses:\n${findings.slice(0, 5).join('\n')}${findings.length > 5 ? `\n(+${findings.length - 5} more)` : ''}`);
  }
  if (toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls)];
    parts.push(`Tools used: ${uniqueTools.join(', ')} (${toolCalls.length} total calls)`);
  }

  return parts.join('\n\n') || '(No significant findings in trimmed context)';
}

/**
 * Update working memory after a model response. Extracts key findings,
 * file references, and hypotheses from the latest AI message and appends
 * them to the running summary.
 *
 * Now also populates the structured `auditedFiles` and `discoveredFindings`
 * arrays in the state, which survive context trimming — the old regex-based
 * approach was fragile against LLM formatting variations.
 */
function updateWorkingMemory(
  state: GraphState,
  newMessage: BaseMessage,
): { memory: string; auditedFiles: string[]; discoveredFindings: string[] } {
  const content = typeof newMessage.content === 'string'
    ? newMessage.content
    : JSON.stringify(newMessage.content);

  let memory = state.workingMemory || '';

  // Extract structured findings
  const hitMatches = content.match(/\[Hit\][^\n]*/g);
  const alertMatches = content.match(/\[Alert\][^\n]*/g);
  const cweMatches = content.match(/CWE-\d{1,4}[^\n]*/g);

  const newEntries: string[] = [];
  const newFindings: string[] = [];
  const newAuditedFiles: string[] = [];

  if (hitMatches?.length) {
    newEntries.push(`Findings: ${hitMatches.map((h) => h.trim()).join('; ')}`);
    newFindings.push(...hitMatches.map((h) => h.trim()));
  }
  if (alertMatches?.length) {
    newEntries.push(`Alerts: ${alertMatches.map((a) => a.trim()).join('; ')}`);
    newFindings.push(...alertMatches.map((a) => a.trim()));
  }
  if (cweMatches?.length && !hitMatches?.length) {
    newEntries.push(`CWE references: ${[...new Set(cweMatches)].join(', ')}`);
    newFindings.push(...cweMatches);
  }

  // Extract file paths using a more robust pattern than the old fragile regex.
  // Match common file extensions in code contexts (backtick-wrapped, paths, etc.)
  const filePattern = /(?:`|['"]|\b)([\w./-]+\.(?:ts|tsx|js|jsx|py|go|java|rs|php|rb|c|h|cpp|cxx|hpp|vue|svelte|swift|kt|kts|cs|fs|fsx|sql|yaml|yml|json|xml|toml|cfg|ini|env|dockerfile|makefile)(?:`|['"]|\b))/gi;
  const fileRefs = content.match(filePattern);
  if (fileRefs?.length) {
    const cleaned = fileRefs.map((f) => f.replace(/[`'"]/g, '').trim()).filter((f) => f.length > 2);
    newAuditedFiles.push(...cleaned);
    if (!memory.includes('Files examined:')) {
      const uniqueFiles = [...new Set(cleaned)].slice(0, 10);
      newEntries.push(`Files referenced: ${uniqueFiles.join(', ')}`);
    }
  }

  // Also detect files referenced with explicit markers (File:, FILE:, 📄, 📁)
  // as a complement to the structured pattern above.
  const markerPattern = /(?:File:|📄|📁|FILE:)\s*([^\s,\n]+)/gi;
  let markerMatch;
  while ((markerMatch = markerPattern.exec(content)) !== null) {
    const cleaned = markerMatch[1]!.replace(/[`'"]/g, '').trim();
    if (cleaned.length > 2 && cleaned.length < 200 && !newAuditedFiles.includes(cleaned)) {
      newAuditedFiles.push(cleaned);
    }
  }

  if (newEntries.length > 0) {
    const timestamp = new Date().toLocaleTimeString();
    memory = memory
      ? `${memory}\n[${timestamp}] ${newEntries.join(' | ')}`
      : `[${timestamp}] ${newEntries.join(' | ')}`;
  }

  // Keep working memory within reasonable size (max ~2000 chars)
  if (memory.length > 2000) {
    const lines = memory.split('\n');
    memory = lines.slice(-15).join('\n'); // Keep last 15 entries
  }

  return {
    memory,
    auditedFiles: newAuditedFiles,
    discoveredFindings: newFindings,
  };
}

/**
 * Node role prompts for multi-stage analysis.
 * Each node specializes the LLM for a particular analysis phase.
 */
const NODE_PROMPTS = {
  graphTracer: `You are a data flow tracer specializing in security analysis.
Your role is to trace how data flows through the codebase from sources (user input, external data) to sinks (dangerous operations like eval, exec, SQL queries, file operations).

Analyze the tool results you've received and identify:
1. Data flow paths from input sources to sensitive operations
2. Missing validation or sanitization along the path
3. Potential taint propagation through function calls

Provide precise, evidence-based analysis with file paths and line numbers.
If you need more information, use the available tools to gather it.
When your tracing analysis is complete, summarize your findings clearly.`,

  sastAnalyzer: `You are a static application security testing (SAST) analyzer.
Your role is to identify security vulnerabilities in source code by examining code patterns, data flows, and common weakness patterns.

Analyze the code provided and look for:
1. Injection vulnerabilities (SQL injection, command injection, XSS, SSRF)
2. Authentication and authorization flaws
3. Insecure data handling (hardcoded secrets, improper encryption)
4. Input validation gaps
5. Race conditions and TOCTOU issues

Use the available tools to read files, search the codebase, and retrieve relevant context.
Provide precise findings with file paths, line numbers, and CWE classifications.
When your analysis is complete, summarize your findings.`,

  verifier: `You are a security finding verifier operating under strict Anti-Hallucination Protocol.
Your role is to validate candidate vulnerabilities identified by other analysis stages.

For each potential finding, verify:
1. The code location exists and is accurately described
2. The vulnerability is real and exploitable (not a false positive)
3. The data flow path from source to sink is valid
4. No mitigating controls (sanitization, validation) are present
5. The severity classification is appropriate

Use the available tools to independently verify each finding.
Reject findings that lack concrete evidence or are based on assumptions.
Provide a clear verdict for each finding: CONFIRMED, LIKELY, or FALSE_POSITIVE.`,

  reflector: `You are a quality assurance reviewer. Review the last analysis response for:
1. **Completeness**: Did it address all parts of the user's request? Are there gaps?
2. **Evidence Quality**: Are claims backed by specific file paths, line numbers, or tool results?
3. **Hallucination Risk**: Are there any claims that seem unsupported or speculative?
4. **Actionability**: Can a developer act on these findings?

Output one of:
- "PASS" — response is complete and well-evidenced
- "RETRY: <specific feedback>" — response needs improvement, with concrete suggestions

Be concise. If passing, just say PASS. If not, give 1-2 sentences of specific feedback.`,

  supervisor: `You are the Supervisor orchestrator for a multi-agent security analysis system.

Your role is to examine the current analysis state and decide which specialized agent should handle the next step:

- **SastAnalyzer**: Static analysis — identify injection vulnerabilities, auth flaws, insecure data handling, input validation gaps, race conditions. Route here when raw code needs security scanning.
- **GraphTracer**: Data-flow tracing — trace data from sources (user input, external data) to sinks (eval, exec, SQL, file ops). Route here when you need to understand how data moves through the code.
- **Verifier**: Finding verification — independently validate candidate vulnerabilities against code evidence. Route here when findings need confirmation before reporting.
- **ToolExecutor**: Route here ONLY when you determine that the current specialist needs tool access (file reads, code search, etc.) — note that specialists bind their own tools.
- **Reflector**: Quality review — route a completed analysis for quality assurance before finalizing.
- **END**: Terminate when analysis is complete, all findings are verified, and quality review has passed.

Respond with a JSON object containing:
- "next_node": the node to execute next
- "rationale": a brief explanation of your decision`,
};

export interface CompileWorkflowOptions {
  checkpointer?: BaseCheckpointSaver;
  model: BaseChatModel;
  providerHint?: string;
  /** System prompt injected before each model invocation (role + tool guidance). */
  systemPrompt?: string;
  toolRetriever?: ToolRetriever;
  tools: ToolEntry[];
}

/**
 * Checks whether an AIMessage contains tool calls.
 * Handles both LangChain's direct tool_calls property and
 * the additional_kwargs.tool_calls format used by some providers.
 */
function hasToolCalls(message: AIMessage): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }

  const kwargsToolCalls = message.additional_kwargs?.tool_calls;
  if (Array.isArray(kwargsToolCalls) && kwargsToolCalls.length > 0) {
    return true;
  }

  return false;
}

function getMessageIterationCount(state: GraphState): number {
  return state.messages.filter((m: BaseMessage) => m instanceof AIMessage).length;
}

/**
 * Build a dynamic system prompt that includes the current working memory.
 * Called before each model invocation so the model always has the latest
 * analysis state without needing to re-read the full conversation.
 */
function buildDynamicSystemPrompt(
  baseSystemMsg: SystemMessage | null,
  nodePrompt?: string,
  workingMemory?: string,
): SystemMessage[] {
  const messages: SystemMessage[] = [];

  if (baseSystemMsg) {
    // Inject working memory into the system prompt if available
    if (workingMemory) {
      const enrichedContent = `${baseSystemMsg.content}\n\n## CURRENT ANALYSIS STATE (Working Memory)\n${workingMemory}\n\nUse this summary to avoid redundant work. Update it mentally as you discover new findings.`;
      messages.push(new SystemMessage({ content: enrichedContent }));
    } else {
      messages.push(baseSystemMsg);
    }
  }

  if (nodePrompt) {
    messages.push(new SystemMessage({ content: nodePrompt }));
  }

  return messages;
}

/**
 * Generic routing logic used after any node that invokes the model.
 * Routes to ToolExecutor if the model made tool calls, to Reflector if
 * the model produced a text response (for quality review), or to END
 * if max iterations reached.
 */
function routeAfterModelInvocation(
  state: GraphState,
  fallback: string,
): string {
  const lastMessage = state.messages.at(-1);

  if (lastMessage instanceof AIMessage && hasToolCalls(lastMessage)) {
    if (checkRepetitiveLoop(state)) {
      return END;
    }
    return 'ToolExecutor';
  }

  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) {
    return END;
  }

  if (lastMessage instanceof AIMessage) {
    // Route through Reflector for quality review before ending
    return 'Reflector';
  }

  return fallback;
}

/**
 * Routing function after ToolExecutor: if a tool set pendingHumanInput (via
 * a Command throw), route to HumanIntervention so the graph pauses at
 * interruptBefore. Otherwise, return to Supervisor to continue the loop.
 */
function routeFromToolExecutor(state: GraphState): string {
  if (state.pendingHumanInput) {
    return 'HumanIntervention';
  }

  return 'Supervisor';
}

/**
 * Routing function for the supervisor node.
 *
 * Reads the `nextNode` field set by the Supervisor's structured output.
 * This makes multi-agent delegation real, deterministic, and traceable —
 * the Supervisor's LLM decides which specialist (SastAnalyzer, GraphTracer,
 * Verifier) handles the current analysis state, replacing the old static
 * fallback that always defaulted to SastAnalyzer.
 */
function routeFromSupervisor(state: GraphState): string {
  const nextNode = state.nextNode;

  // Guard: if nextNode was set to END via the structured output, terminate.
  if (nextNode === END || !nextNode) {
    return END;
  }

  // Validate: only route to known nodes.
  const validNodes = new Set([
    'ToolExecutor', 'SastAnalyzer', 'GraphTracer', 'Verifier', 'Reflector',
  ]);
  if (!validNodes.has(nextNode)) {
    return END;
  }

  // Enforce iteration limit as a safety net.
  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) return END;

  // Anti-loop check: if we've been cycling through the same state, stop.
  if (checkRepetitiveLoop(state)) return END;

  return nextNode;
}

/**
 * Routing function for specialist nodes (SastAnalyzer, GraphTracer, Verifier).
 * After a specialist runs the model, check if it wants to call tools.
 * If the model produced text output, route through Reflector for quality review.
 */
function routeFromSpecialist(state: GraphState): string {
  return routeAfterModelInvocation(state, 'Supervisor');
}

/**
 * Routing function after the Reflector reviews output quality.
 *
 * The Reflector node invokes the model WITHOUT tools (pure review), so
 * hasToolCalls is always false — the previous code's tool-call check was
 * dead code. Simplified to a clean binary:
 *   PASS  → END (analysis complete)
 *   RETRY → Supervisor (with critique in message history)
 *   Exhausted iterations → END
 */
function routeFromReflector(state: GraphState): string {
  const lastMessage = state.messages.at(-1);

  if (lastMessage instanceof AIMessage) {
    const content = typeof lastMessage.content === 'string'
      ? lastMessage.content
      : '';

    // PASS: analysis is complete and well-evidenced
    if (content.startsWith('PASS') || content.includes('\nPASS')) {
      return END;
    }

    // RETRY: analysis needs improvement — go back to Supervisor with
    // the reflector's critique appended to the message history.
    if (content.startsWith('RETRY') || content.includes('\nRETRY')) {
      return 'Supervisor';
    }
  }

  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) return END;

  // Unclear or unrecognized verdict: return to Supervisor for re-evaluation
  return 'Supervisor';
}

export function compileWorkflow(options: CompileWorkflowOptions) {
  const { checkpointer, model, providerHint, systemPrompt, toolRetriever, tools } = options;
  const wrappedTools = tools.map((entry) => wrapTool(entry.tool, entry.name, { providerHint }));
  const toolNode = new ToolNode(wrappedTools);
  const retriever = toolRetriever ?? new ToolRetriever(wrappedTools.map((t, i) => ({ name: t.name ?? `tool_${i}`, tool: tools[i]!.tool })));

  if (!model.bindTools) {
    throw new Error('Model does not support bindTools');
  }

  const bindTools = model.bindTools.bind(model);

  // Reset module-level human-in-loop state so each workflow compilation
  // starts with a clean slate (no stale pending signatures).
  resetHumanInLoopState();
  enableLangGraphContext();

  // Pre-built system message injected before every model invocation.
  const systemMsg = systemPrompt
    ? new SystemMessage({ content: systemPrompt })
    : null;

  // =========================================================================
  // All node functions are defined INSIDE compileWorkflow so they have
  // closure access to the model and tool retriever. Each node invokes the
  // model with a specialized system prompt including working memory.
  // =========================================================================

  async function bindModel(state: GraphState, config?: RunnableConfig) {
    const selected = await retriever.retrieve(state.messages);
    const bound = bindTools(selected, config);
    return bound;
  }

  /**
   * Trim context and summarize if needed. Returns the messages to use,
   * updated working memory, and the structured state arrays.
   */
  function prepareContext(state: GraphState): {
    messages: BaseMessage[];
    updatedMemory: string;
    auditedFiles: string[];
    discoveredFindings: string[];
  } {
    if (state.messages.length > SUMMARIZE_THRESHOLD) {
      return trimContext(state);
    }
    return {
      messages: state.messages,
      updatedMemory: state.workingMemory,
      auditedFiles: state.auditedFiles,
      discoveredFindings: state.discoveredFindings,
    };
  }

  /**
   * SAST Analyzer node: invokes the model with a security analysis system prompt.
   */
  async function sastAnalyzerNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory, auditedFiles, discoveredFindings } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, NODE_PROMPTS.sastAnalyzer, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const memResult = updateWorkingMemory(state, response);
    return {
      messages: [response],
      workingMemory: memResult.memory || updatedMemory,
      auditedFiles: [...new Set([...auditedFiles, ...memResult.auditedFiles])],
      discoveredFindings: [...new Set([...discoveredFindings, ...memResult.discoveredFindings])],
    };
  }

  /**
   * Graph Tracer node: invokes the model with a data-flow tracing system prompt.
   */
  async function graphTracerNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory, auditedFiles, discoveredFindings } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, NODE_PROMPTS.graphTracer, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const memResult = updateWorkingMemory(state, response);
    return {
      messages: [response],
      workingMemory: memResult.memory || updatedMemory,
      auditedFiles: [...new Set([...auditedFiles, ...memResult.auditedFiles])],
      discoveredFindings: [...new Set([...discoveredFindings, ...memResult.discoveredFindings])],
    };
  }

  /**
   * Verifier node: invokes the model with a finding verification system prompt.
   */
  async function verifierNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory, auditedFiles, discoveredFindings } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, NODE_PROMPTS.verifier, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const memResult = updateWorkingMemory(state, response);
    return {
      messages: [response],
      workingMemory: memResult.memory || updatedMemory,
      auditedFiles: [...new Set([...auditedFiles, ...memResult.auditedFiles])],
      discoveredFindings: [...new Set([...discoveredFindings, ...memResult.discoveredFindings])],
    };
  }

  /**
   * Supervisor node: the intelligent orchestrator that decides which
   * specialist node should handle the current analysis state. Uses
   * structured output (JSON Schema via Zod) to produce a deterministic,
   * traceable routing decision — replacing the old static fallback that
   * always defaulted to SastAnalyzer and left GraphTracer/Verifier orphaned.
   */
  async function supervisorNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory, auditedFiles, discoveredFindings } = prepareContext(state);

    // Build the routing prompt with current state context
    const supervisorSystemPrompt = `## WORKING MEMORY\n${updatedMemory || '(empty)'}\n\n## RECENT MESSAGES\n${messages.slice(-6).map((m) => {
      const role = m instanceof AIMessage ? 'AI' : m instanceof HumanMessage ? 'Human' : 'System';
      const content = typeof m.content === 'string' ? m.content.slice(0, 500) : JSON.stringify(m.content).slice(0, 500);
      return `[${role}] ${content}`;
    }).join('\n\n')}`;

    const routingMessages: BaseMessage[] = [
      new SystemMessage({ content: NODE_PROMPTS.supervisor }),
      new HumanMessage({ content: `Current analysis state:\n\n${supervisorSystemPrompt}\n\nBased on the current state, which node should execute next? Respond with the JSON routing decision.` }),
    ];

    // Use structured output for deterministic routing — no tool calls from
    // the supervisor itself; specialists handle tool execution.
    const modelWithRouting = model.withStructuredOutput(supervisorRoutingSchema);
    const routingDecision = await modelWithRouting.invoke(routingMessages, config);

    const nextNode = routingDecision.next_node === 'END' ? END : routingDecision.next_node;

    return {
      messages: [new AIMessage({ content: `[Supervisor → ${routingDecision.next_node}] ${routingDecision.rationale}` })],
      nextNode,
      workingMemory: updatedMemory,
      auditedFiles,
      discoveredFindings,
    };
  }

  /**
   * Reflector node: reviews the last AI response for quality, completeness,
   * and evidence support. Outputs PASS or RETRY with specific feedback.
   * This node does NOT call tools — it's a pure review step.
   */
  async function reflectorNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory, auditedFiles, discoveredFindings } = prepareContext(state);

    // Find the last non-reflector AI message to review
    const lastAI = [...messages].reverse().find(
      (m) => m instanceof AIMessage && !(typeof m.content === 'string' && (m.content.startsWith('PASS') || m.content.startsWith('RETRY'))),
    );

    if (!lastAI) {
      // No AI message to review — pass through
      return { workingMemory: updatedMemory, auditedFiles, discoveredFindings };
    }

    // Build a focused review prompt with just the message to review
    const reviewPrompt = `Review this analysis output for quality:

---
${typeof lastAI.content === 'string' ? lastAI.content.slice(0, 2000) : JSON.stringify(lastAI.content).slice(0, 2000)}
---

Respond with PASS if the output is complete and well-evidenced, or RETRY: <specific feedback> if it needs improvement.`;

    const reviewMessages: BaseMessage[] = [
      new SystemMessage({ content: NODE_PROMPTS.reflector }),
      new HumanMessage({ content: reviewPrompt }),
    ];

    // Use the model WITHOUT tools for pure review (no tool distractions)
    const response = await model.invoke(reviewMessages, config);

    // If PASS, the reviewed message stands. If RETRY, the feedback guides
    // the next Supervisor invocation.
    return {
      messages: [response],
      workingMemory: updatedMemory,
      auditedFiles,
      discoveredFindings,
    };
  }

  /**
   * HumanIntervention node: a passthrough that exists solely as an
   * interruptBefore point. When a tool throws a Command to request human
   * input (setting pendingHumanInput), the graph routes here. Because the
   * compile call declares `interruptBefore: ['HumanIntervention']`, the graph
   * pauses before entering this node, checkpointing state. The TUI detects the
   * pause, shows the question, and resumes the graph with the human's answer.
   */
  async function humanInterventionNode(state: GraphState): Promise<Partial<GraphState>> {
    return {
      pendingHumanInput: null,
      workingMemory: state.workingMemory,
      auditedFiles: state.auditedFiles,
      discoveredFindings: state.discoveredFindings,
    };
  }

  const workflow = new StateGraph(AgentState)
    .addNode('SastAnalyzer', sastAnalyzerNode)
    .addNode('GraphTracer', graphTracerNode)
    .addNode('Verifier', verifierNode)
    .addNode('Supervisor', supervisorNode)
    .addNode('ToolExecutor', toolNode)
    .addNode('HumanIntervention', humanInterventionNode)
    .addNode('Reflector', reflectorNode)
    .addEdge(START, 'Supervisor')
    .addConditionalEdges('Supervisor', routeFromSupervisor)
    .addConditionalEdges('SastAnalyzer', routeFromSpecialist)
    .addConditionalEdges('GraphTracer', routeFromSpecialist)
    .addConditionalEdges('Verifier', routeFromSpecialist)
    .addConditionalEdges('ToolExecutor', routeFromToolExecutor)
    .addConditionalEdges('Reflector', routeFromReflector)
    .addEdge('HumanIntervention', 'Supervisor');

  return workflow.compile({
    checkpointer,
    interruptBefore: ['HumanIntervention'],
  });
}
