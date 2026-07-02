import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { AIMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
import {
  END,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { type ToolSet } from 'ai';

import { AgentState } from './state.js';
import { ToolRetriever } from './tool-retriever.js';
import { wrapTool } from './tools/langchain-wrapper.js';

type GraphState = typeof AgentState.State;
type ToolEntry = { name: string; tool: ToolSet[string] };

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 25;

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
};

export interface CompileWorkflowOptions {
  checkpointer?: BaseCheckpointSaver;
  model: BaseChatModel;
  providerHint?: string;
  toolRetriever?: ToolRetriever;
  tools: ToolEntry[];
}

/**
 * Checks whether an AIMessage contains tool calls.
 * Handles both LangChain's direct tool_calls property and
 * the additional_kwargs.tool_calls format used by some providers.
 */
function hasToolCalls(message: AIMessage): boolean {
  // Check LangChain's standard tool_calls property
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }

  // Check additional_kwargs (used by some chat model implementations)
  const kwargsToolCalls = message.additional_kwargs?.tool_calls;
  if (Array.isArray(kwargsToolCalls) && kwargsToolCalls.length > 0) {
    return true;
  }

  return false;
}

function getMessageIterationCount(state: GraphState): number {
  // Count how many AI messages have been produced (rough iteration guard)
  return state.messages.filter((m: BaseMessage) => m instanceof AIMessage).length;
}

/**
 * Generic routing logic used after any node that invokes the model.
 * Routes to ToolExecutor if the model made tool calls, to END if
 * the model produced a final text response, or to a fallback node.
 */
function routeAfterModelInvocation(
  state: GraphState,
  fallback: string,
): string {
  const lastMessage = state.messages.at(-1);

  // If the model wants to call tools, route to tool executor
  if (lastMessage instanceof AIMessage && hasToolCalls(lastMessage)) {
    return 'ToolExecutor';
  }

  // Iteration guard: prevent infinite loops
  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) {
    return END;
  }

  // If we've got an AI response without tool calls, the analysis is complete
  if (lastMessage instanceof AIMessage) {
    return END;
  }

  // Fallback: route to the designated next step
  return fallback;
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

  // If the model wants to call tools, route to tool executor
  if (lastMessage instanceof AIMessage && hasToolCalls(lastMessage)) {
    return 'ToolExecutor';
  }

  // Iteration guard: prevent infinite loops
  const iterations = getMessageIterationCount(state);
  if (iterations >= MAX_ITERATIONS) {
    return END;
  }

  // If we've got an AI response without tool calls, analysis is complete
  if (lastMessage instanceof AIMessage) {
    return END;
  }

  // Default: route to SAST analyzer for initial/deeper analysis
  return 'SastAnalyzer';
}

/**
 * Routing function for specialist nodes (SastAnalyzer, GraphTracer, Verifier).
 * After a specialist runs the model, check if it wants to call tools.
 */
function routeFromSpecialist(state: GraphState): string {
  return routeAfterModelInvocation(state, 'Supervisor');
}

export function compileWorkflow(options: CompileWorkflowOptions) {
  const { checkpointer, model, providerHint, toolRetriever, tools } = options;
  const wrappedTools = tools.map((entry) => wrapTool(entry.tool, entry.name, { providerHint }));
  const toolNode = new ToolNode(wrappedTools);
  const retriever = toolRetriever ?? new ToolRetriever(wrappedTools.map((t, i) => ({ name: t.name ?? `tool_${i}`, tool: tools[i]!.tool })));

  if (!model.bindTools) {
    throw new Error('Model does not support bindTools');
  }

  const bindTools = model.bindTools.bind(model);

  // =========================================================================
  // All node functions are defined INSIDE compileWorkflow so they have
  // closure access to the model and tool retriever. Each node invokes the
  // model with a specialized system prompt, producing real AI responses.
  // =========================================================================

  async function bindModel(state: GraphState, config?: RunnableConfig) {
    const selected = await retriever.retrieve(state.messages);
    const bound = bindTools(selected, config);
    return bound;
  }

  /**
   * SAST Analyzer node: invokes the model with a security analysis system prompt.
   * The model can use tools to read files, search code, and gather context.
   */
  async function sastAnalyzerNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const systemMsg = new SystemMessage({ content: NODE_PROMPTS.sastAnalyzer });
    const modelWithTools = await bindModel(state, config);
    const response = await modelWithTools.invoke([systemMsg, ...state.messages], config);
    return { messages: [response] };
  }

  /**
   * Graph Tracer node: invokes the model with a data-flow tracing system prompt.
   * The model can use tools to trace data flows from sources to sinks.
   */
  async function graphTracerNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const systemMsg = new SystemMessage({ content: NODE_PROMPTS.graphTracer });
    const modelWithTools = await bindModel(state, config);
    const response = await modelWithTools.invoke([systemMsg, ...state.messages], config);
    return { messages: [response] };
  }

  /**
   * Verifier node: invokes the model with a finding verification system prompt.
   * The model can use tools to independently validate candidate vulnerabilities.
   */
  async function verifierNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const systemMsg = new SystemMessage({ content: NODE_PROMPTS.verifier });
    const modelWithTools = await bindModel(state, config);
    const response = await modelWithTools.invoke([systemMsg, ...state.messages], config);
    return { messages: [response] };
  }

  /**
   * Supervisor node: the main LLM orchestrator that decides what to do next.
   * It has access to all tools and coordinates the analysis pipeline.
   */
  async function supervisorNode(
    state: GraphState,
    config?: RunnableConfig,
  ): Promise<Partial<GraphState>> {
    const modelWithTools = await bindModel(state, config);
    const response = await modelWithTools.invoke(state.messages, config);
    return { messages: [response] };
  }

  const workflow = new StateGraph(AgentState)
    .addNode('SastAnalyzer', sastAnalyzerNode)
    .addNode('GraphTracer', graphTracerNode)
    .addNode('Verifier', verifierNode)
    .addNode('Supervisor', supervisorNode)
    .addNode('ToolExecutor', toolNode)
    .addEdge(START, 'Supervisor')
    .addConditionalEdges('Supervisor', routeFromSupervisor)
    .addConditionalEdges('SastAnalyzer', routeFromSpecialist)
    .addConditionalEdges('GraphTracer', routeFromSpecialist)
    .addConditionalEdges('Verifier', routeFromSpecialist)
    .addEdge('ToolExecutor', 'Supervisor');

  return workflow.compile({
    checkpointer,
  });
}
