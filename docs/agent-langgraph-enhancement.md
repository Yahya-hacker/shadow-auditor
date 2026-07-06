# Shadow Auditor — Agent & LangGraph Deep Enhancement Plan

## 1. Architecture Overview

### Current LangGraph Flow
```
START → Supervisor → [SastAnalyzer | GraphTracer | Verifier] → ToolExecutor → HumanIntervention → END
```

### Problems Found

#### P1: Router is naive — no planning phase
**Severity: HIGH**
The `routeFromSupervisor` simply checks "has tool calls? → ToolExecutor, is AIMessage? → END, else → SastAnalyzer". There's no multi-step planning before execution. The model is asked to "do everything in one shot" which leads to shallow analysis on complex tasks.

**Fix:** Add a "Plan" node before Supervisor that decomposes complex user requests into subtasks, stored in working memory.

#### P2: No reflection/self-review loop
**Severity: HIGH**
The workflow produces output but never reviews it. Hallucinated findings, incomplete analysis, or low-confidence results pass straight through to the user.

**Fix:** Add a "Reflect" node after each specialist run that reviews output quality. If below threshold, route back for improvement.

#### P3: Context grows unbounded in long sessions
**Severity: HIGH**
`trimContext` caps at 40 messages but the checkpoint stores ALL messages. Over a multi-hour analysis session, the checkpoint file bloats and model context overflows. Critical early findings get trimmed away.

**Fix:** Implement periodic summarization — compress old messages into a concise "analysis progress summary" kept in a `workingMemory` state field.

#### P4: ToolRetriever uses naive keyword overlap
**Severity: MEDIUM**
The ToolRetriever's `keywordRetrieve` method uses simple token overlap counting. For a security analysis tool, keyword "SQL" would match "read_file" (no) and miss "context_retrieval" (yes, for DB patterns).

**Fix:** 
1. Add semantic embedding-based scoring via the existing embedding provider
2. Add tool usage examples in tool descriptions for better LLM-driven selection
3. Add tool co-occurrence hints ("after search_codebase, use read_file to inspect matches")

#### P5: Tool results are raw and unprocessed
**Severity: MEDIUM**
When `read_file` returns a 5000-line file or `search_codebase` returns 100 matches, the full result is injected into context. This wastes tokens and can cause the model to lose focus.

**Fix:** Add result post-processing: truncate large outputs with summaries, add "top N" hints, and include continuation markers for pagination.

#### P6: No working memory across supersteps
**Severity: HIGH**
The system prompt is static. The model doesn't "remember" what it already discovered between tool calls. It must re-read the conversation history to recall findings, which is inefficient.

**Fix:** Add a `workingMemory` field to the LangGraph state. After each significant discovery, update working memory. Inject it into the system prompt so the model always has a concise summary of what's been found.

#### P7: Human-in-the-loop has no timeout or batch mode
**Severity: MEDIUM**
When the graph pauses for human confirmation, it waits indefinitely. For long sessions, this means the user might step away and the entire analysis stalls. Also, each file edit requires separate confirmation.

**Fix:**
1. Add configurable timeout (auto-deny after N minutes)
2. Add "approve all" pattern for batch edits
3. Track decision history so repeated similar confirmations can be auto-approved

#### P8: Checkpoint files grow without bound
**Severity: MEDIUM**
Each `streamEvents` creates a new checkpoint file. Over a long session, hundreds of checkpoint files accumulate.

**Fix:** Add checkpoint compaction — keep only the most recent N checkpoints plus a "milestone" checkpoint every M steps.

#### P9: Specialist nodes are underutilized
**Severity: HIGH**
The specialists (SastAnalyzer, GraphTracer, Verifier) are only activated based on `routeFromSupervisor`'s fallback logic. In practice, the Supervisor often just calls tools directly and never delegates to specialists. The specialist prompts and capabilities are wasted.

**Fix:** Restructure routing:
- After planning, ALWAYS route through specialists based on task type
- Supervisor coordinates, specialists execute
- Add a "Verifier" check after every finding

#### P10: No error recovery edges in the graph
**Severity: MEDIUM**
If ToolExecutor encounters an error (tool crash, timeout), it routes back to Supervisor. But the error message might be cryptic, and the Supervisor has no guidance on recovery.

**Fix:** Add error-classification in ToolExecutor output. Route to a "Recovery" node that suggests alternative approaches.

#### P11: Swarm workers use Vercel AI SDK, not LangGraph
**Severity: MEDIUM**
The swarm uses `streamWithContinuation` (Vercel AI SDK) while the main agent uses LangGraph. This creates a split architecture where improvements to one path don't benefit the other.

**Fix:** Migrate swarm workers to LangGraph for consistency. Each worker gets its own mini-StateGraph with tool-use loop.

#### P12: Worker prompts lack concrete tool instructions
**Severity: MEDIUM**
Worker prompts are role-focused but don't include tool-specific guidance. Workers don't know the best tool to use for each subtask.

**Fix:** Add tool usage examples and sequences to worker prompts. "To find SQL injection: 1) context_retrieval('SQL query construction'), 2) read_file on matched files, 3) search_codebase for parameterization patterns"

---

## 2. Implementation Plan

### Phase 1: Core Intelligence (highest impact)

#### 2.1 Add Working Memory to State
**File:** `src/core/graph/state.ts`
- Add `workingMemory: Annotation<string>` to AgentState
- Reducer: replaces on each update (latest value)
- Contains: key findings, current hypothesis, files examined, confidence scores

#### 2.2 Add Reflection Node
**File:** `src/core/graph/workflow.ts`
- New node: `reflectorNode` — reviews last response for quality
- Checks: completeness, evidence quality, hallucination risk
- Route: if quality < threshold → back to Supervisor with improvement hints
- New edge: all specialist nodes → Reflector → (Supervisor | END)

#### 2.3 Context Summarization
**File:** `src/core/graph/workflow.ts`
- New function: `summarizeContext(messages, workingMemory) → string`
- Called when messages exceed 30: compresses oldest 20 into a summary
- Stored in `workingMemory` state field
- Injected into system prompt as "## ANALYSIS PROGRESS" section

#### 2.4 Enhanced System Prompt with Working Memory
**File:** `src/core/system-prompt.ts`
- Add `workingMemory` parameter
- Include "## CURRENT ANALYSIS STATE" section with findings, hypotheses, progress

### Phase 2: Tool Intelligence

#### 2.5 Tool Description Enhancement
**Files:** All tool files (`bash.ts`, `context-retrieval.ts`, etc.)
- Add usage examples in descriptions
- Add "when to use" vs "when not to use" guidance
- Add result format documentation
- Add tool chaining hints

#### 2.6 Tool Result Post-Processing
**File:** `src/core/graph/tools/langchain-wrapper.ts`
- Add result truncation for large outputs
- Add summary generation for multi-result tools
- Add continuation hints for paginated results

#### 2.7 ToolRetriever Semantic Scoring
**File:** `src/core/graph/tool-retriever.ts`
- Add embedding-based scoring using optional embedProvider
- Add tool co-occurrence matrix for better recommendations
- Add LLM-based tool selection as fallback

### Phase 3: Long-Task Resilience

#### 2.8 Checkpoint Compaction
**File:** `src/core/orchestrator/checkpoint-saver.ts`
- Add `compact()` method that keeps only N most recent + milestone checkpoints
- Add checkpoint metadata (timestamp, summary)

#### 2.9 Human-in-the-Loop Timeout
**File:** `src/utils/human-in-loop.ts`
- Add configurable timeout parameter
- Auto-deny after timeout with logged reason

#### 2.10 Graph Error Recovery
**File:** `src/core/graph/workflow.ts`
- Add error classification in ToolExecutor output
- Add RecoveryNode that suggests alternative approaches
- Add retry counter to prevent infinite loops

---

## 3. File Changes Summary

| File | Changes |
|------|---------|
| `src/core/graph/state.ts` | Add `workingMemory` field |
| `src/core/graph/workflow.ts` | Add Reflector node, summarization, enhanced routing |
| `src/core/graph/tool-retriever.ts` | Semantic scoring, co-occurrence hints |
| `src/core/graph/tools/langchain-wrapper.ts` | Result processing, truncation |
| `src/core/system-prompt.ts` | Working memory injection, enhanced directives |
| `src/core/agent.ts` | Wire working memory, pass to system prompt |
| `src/core/orchestrator/checkpoint-saver.ts` | Compaction, metadata |
| `src/utils/human-in-loop.ts` | Timeout, batch approval |
| All tool files | Enhanced descriptions with examples |
| `src/core/hivemind/worker-prompts.ts` | Tool usage guidance, sequences |
