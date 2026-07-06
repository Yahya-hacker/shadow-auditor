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

/** Compute a stable hash of the last K AI messages to detect loops. */
function computeStateHash(state: GraphState): string {
  const recentAI = state.messages
    .filter((m) => m instanceof AIMessage)
    .slice(-5)
    .map((m) => (m as AIMessage).content)
    .join('');
  return crypto.createHash('sha256').update(recentAI).digest('hex').slice(0, 12);
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
 */
function trimContext(state: GraphState): { messages: BaseMessage[]; updatedMemory: string } {
  const messages = state.messages;
  if (messages.length <= MAX_CONTEXT_MESSAGES) {
    return { messages, updatedMemory: state.workingMemory };
  }

  // Keep first message (system context) + last N-1 messages
  const first = messages[0];
  const recent = messages.slice(-(MAX_CONTEXT_MESSAGES - 1));
  const dropped = messages.slice(1, -(MAX_CONTEXT_MESSAGES - 1));

  // Summarize the dropped messages into a compact form
  const summary = summarizeDroppedMessages(dropped);
  const updatedMemory = state.workingMemory
    ? `${state.workingMemory}\n\n[Auto-summarized earlier context]:\n${summary}`
    : `[Auto-summarized earlier context]:\n${summary}`;

  return { messages: [first, ...recent], updatedMemory };
}

/**
 * Compress dropped messages into a concise summary for working memory.
 * Extracts key findings, file references, and hypotheses from older messages
 * so they survive context trimming.
 */
function summarizeDroppedMessages(messages: BaseMessage[]): string {
  const findings: string[] = [];
  const filesExamined = new Set<string>();
  const toolCalls: string[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Extract file paths mentioned in the message
    const fileMatches = content.match(/(?:File:|📄|📁|FILE:)\s*([^\s,\n]+)/gi);
    if (fileMatches) {
      for (const m of fileMatches) {
        const cleaned = m.replace(/(?:File:|📄|📁|FILE:)\s*/i, '').trim();
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
 */
function updateWorkingMemory(state: GraphState, newMessage: BaseMessage): string {
  const content = typeof newMessage.content === 'string'
    ? newMessage.content
    : JSON.stringify(newMessage.content);

  let memory = state.workingMemory || '';

  // Extract structured findings
  const hitMatches = content.match(/\[Hit\][^\n]*/g);
  const alertMatches = content.match(/\[Alert\][^\n]*/g);
  const cweMatches = content.match(/CWE-\d{1,4}[^\n]*/g);

  const newEntries: string[] = [];

  if (hitMatches?.length) {
    newEntries.push(`Findings: ${hitMatches.map((h) => h.trim()).join('; ')}`);
  }
  if (alertMatches?.length) {
    newEntries.push(`Alerts: ${alertMatches.map((a) => a.trim()).join('; ')}`);
  }
  if (cweMatches?.length && !hitMatches?.length) {
    newEntries.push(`CWE references: ${[...new Set(cweMatches)].join(', ')}`);
  }

  // Extract file paths
  const fileRefs = content.match(/(?:`?)[\w./-]+\.(?:ts|tsx|js|jsx|py|go|java|rs|php|rb|c|h|cpp)(?:`?)/gi);
  if (fileRefs?.length && !memory.includes('Files examined:')) {
    const uniqueFiles = [...new Set(fileRefs)].slice(0, 10);
    newEntries.push(`Files referenced: ${uniqueFiles.join(', ')}`);
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

  return memory;
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
 * After the supervisor runs, decide whether to:
 * - Execute tool calls (ToolExecutor)
 * - Route to SAST analysis for deeper investigation (SastAnalyzer)
 * - Terminate the graph (END)
 */
function routeFromSupervisor(state: GraphState): string {
  const lastMessage = state.messages.at(-1);

  if (lastMessage instanceof AIMessage && hasToolCalls(lastMessage)) {
    if (checkRepetitiveLoop(state)) return END;
    return 'ToolExecutor';
  }

  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) return END;

  if (lastMessage instanceof AIMessage) return 'Reflector';

  return 'SastAnalyzer';
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
 * If PASS → END (or back to Supervisor for further work).
 * If RETRY → back to Supervisor with improvement hints.
 */
function routeFromReflector(state: GraphState): string {
  const lastMessage = state.messages.at(-1);

  // Check if the reflector's verdict is PASS
  if (lastMessage instanceof AIMessage) {
    const content = typeof lastMessage.content === 'string'
      ? lastMessage.content
      : '';
    if (content.startsWith('PASS') || content.includes('PASS')) {
      // Check if there are tool calls pending
      if (hasToolCalls(lastMessage)) {
        return 'ToolExecutor';
      }
      return END;
    }
  }

  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) return END;

  // RETRY or unclear: go back to Supervisor with feedback
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
   * Trim context and summarize if needed. Returns the messages to use
   * and an updated working memory string.
   */
  function prepareContext(state: GraphState): { messages: BaseMessage[]; updatedMemory: string } {
    if (state.messages.length > SUMMARIZE_THRESHOLD) {
      return trimContext(state);
    }
    return { messages: state.messages, updatedMemory: state.workingMemory };
  }

  /**
   * SAST Analyzer node: invokes the model with a security analysis system prompt.
   */
  async function sastAnalyzerNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, NODE_PROMPTS.sastAnalyzer, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const newMemory = updateWorkingMemory(state, response);
    return { messages: [response], workingMemory: newMemory || updatedMemory };
  }

  /**
   * Graph Tracer node: invokes the model with a data-flow tracing system prompt.
   */
  async function graphTracerNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, NODE_PROMPTS.graphTracer, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const newMemory = updateWorkingMemory(state, response);
    return { messages: [response], workingMemory: newMemory || updatedMemory };
  }

  /**
   * Verifier node: invokes the model with a finding verification system prompt.
   */
  async function verifierNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, NODE_PROMPTS.verifier, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const newMemory = updateWorkingMemory(state, response);
    return { messages: [response], workingMemory: newMemory || updatedMemory };
  }

  /**
   * Supervisor node: the main LLM orchestrator that decides what to do next.
   */
  async function supervisorNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const { messages, updatedMemory } = prepareContext(state);
    const modelWithTools = await bindModel(state, config);
    const systemMessages = buildDynamicSystemPrompt(systemMsg, undefined, updatedMemory);
    const messagesWithSystem = [...systemMessages, ...messages];
    const response = await modelWithTools.invoke(messagesWithSystem, config);
    const newMemory = updateWorkingMemory(state, response);
    return { messages: [response], workingMemory: newMemory || updatedMemory };
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
    const { messages, updatedMemory } = prepareContext(state);

    // Find the last non-reflector AI message to review
    const lastAI = [...messages].reverse().find(
      (m) => m instanceof AIMessage && !(typeof m.content === 'string' && (m.content.startsWith('PASS') || m.content.startsWith('RETRY'))),
    );

    if (!lastAI) {
      // No AI message to review — pass through
      return { workingMemory: updatedMemory };
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
    return { pendingHumanInput: null, workingMemory: state.workingMemory };
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
