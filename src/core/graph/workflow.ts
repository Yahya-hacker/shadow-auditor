import { StateGraph, END, START, MemorySaver } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { wrapTool } from "./tools/langchain-wrapper.js";
import { BaseMessage, AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";

async function graphTracerNode(state: typeof AgentState.State, config?: RunnableConfig) {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || !(lastMessage instanceof ToolMessage)) {
       return { messages: [new AIMessage({ content: "Need target file and line to trace." })] };
    }
    // TODO: implement actual hybrid-retriever multi-hop trace
    return { messages: [new AIMessage({ content: "GraphTrace complete." })] };
}

async function sastAnalyzerNode(state: typeof AgentState.State, config?: RunnableConfig) {
    return { messages: [new AIMessage({ content: "SastAnalysis complete." })] };
}

async function verifierNode(state: typeof AgentState.State, config?: RunnableConfig) {
    return { messages: [new AIMessage({ content: "Verification complete." })] };
}

async function supervisorNode(state: typeof AgentState.State, config?: RunnableConfig) {
    return { messages: [new AIMessage({ content: "Supervision complete." })] };
}

function router(state: typeof AgentState.State) {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage?.content?.toString().includes("GraphTrace complete")) {
        return "Verifier";
    }
    if (lastMessage?.content?.toString().includes("SastAnalysis complete")) {
        return "GraphTracer";
    }
    if (lastMessage?.content?.toString().includes("Verification complete")) {
        return END;
    }
    return "SastAnalyzer";
}

export function compileWorkflow(tools: any[]) {
  const wrappedTools = tools.map((t: any) => wrapTool(t.tool, t.name));
  const toolNode = new ToolNode(wrappedTools);

  const workflow = new StateGraph(AgentState)
    .addNode("Supervisor", supervisorNode)
    .addNode("SastAnalyzer", sastAnalyzerNode)
    .addNode("GraphTracer", graphTracerNode)
    .addNode("Verifier", verifierNode)
    .addNode("ToolExecutor", toolNode)

    .addEdge(START, "Supervisor")
    .addConditionalEdges("Supervisor", router)
    .addEdge("SastAnalyzer", "Supervisor")
    .addEdge("GraphTracer", "Supervisor")
    .addEdge("Verifier", "Supervisor")
    .addEdge("ToolExecutor", "Supervisor");

  const checkpointer = new MemorySaver();
  return workflow.compile({ checkpointer });
}
