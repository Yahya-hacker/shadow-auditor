# Shadow Auditor — End-to-End Code Analysis

## 1. Complete Execution Flow

### CLI Entry → UI Render
```
bin/run.js → oclif → src/commands/shell.tsx
  ├── loadConfig() from filesystem
  ├── render(<App ...>) via Ink (React terminal renderer)
  └── waitUntilExit()
```

### Screen Flow (App.tsx state machine)
```
boot → setup (if needsSetup) or target
target → initializing (when user selects target path)
initializing → shell (when AgentSession finishes init)
             → license-blocked (if license invalid)
setup → initializing (after config save)
```

### Session Initialization (initSession)
```
useAgentSession.initSession(config, targetPath, options)
  ├── generateRepoMap(targetPath) — AST-level architecture map
  ├── new AgentSession(config, map, targetPath, {userName, diffScopeHint, expertUnsafe})
  │   ├── constructor: resolves runtime settings, seeds initial messages
  │   └── this.initialized = this.initialize()
  │       ├── initializeMcpTools()
  │       ├── RunArtifacts.create() — creates run directory
  │       ├── ReportBuilder — findings collector
  │       ├── initializeMissionRuntime() — MissionEngine (OODA loop)
  │       ├── initializeSemanticIndex() — embeddings + HybridRetriever
  │       ├── buildSystemPrompt() — global system prompt
  │       ├── getLangchainModel() — LangChain model for LangGraph
  │       ├── PersistentCheckpointSaver — filesystem checkpointer
  │       ├── compileWorkflow() — LangGraph StateGraph
  │       └── initializeSwarmCoordinator() — if swarm mode enabled
  └── setScreen('shell')
```

### Message Flow (user sends a message)
```
ShellScreen.handleSubmit(command)
  ├── store.addUserMessage(trimmed)          // Add user message to UI
  ├── store.setInput('')                     // Clear input
  ├── store.clearActivity()                  // Clear tool activity
  ├── store.startStreaming()                 // streaming=true, streamingText=''
  │
  ├── agentSessionRef.current.sendMessage(trimmed, onChunk, onEvent)
  │   └── AgentSession.sendSingleAgentMessage(userMessage, ...)
  │       ├── threadId = 'session_main'
  │       ├── threadCounter++ → if first message: prepend system context
  │       ├── compiledWorkflow.streamEvents({messages: [HumanMessage]}, config)
  │       │   └── LangGraph executes: START → Supervisor → ...
  │       │       ├── supervisorNode: model.invoke([SystemMsg, ...trimmed])
  │       │       ├── routeFromSupervisor()
  │       │       ├── SastAnalyzer / GraphTracer / Verifier / ToolExecutor
  │       │       ├── routeFromToolExecutor() → HumanIntervention (if pending)
  │       │       └── END
  │       │
  │       └── for await (event of stream)
  │           ├── method === 'messages': extract text from content-block-delta/finish
  │           └── method === 'updates': extract tool_call/tool_result
  │
  ├── stream.finish()                        // Flush throttled chunks
  └── store.finishStreaming()                // Move streamingText → messages[]
```

### Rendering Flow
```
ShellScreen
  ├── Layout (computes terminal dimensions)
  │   └── renderLayout callback
  │       ├── Header
  │       ├── ExpandedLayout / CompactLayout
  │       │   ├── FiltersPanel
  │       │   ├── MetadataPanel
  │       │   ├── SwarmPanel (if panelOpen)
  │       │   └── OutputArea
  │       │       ├── visibleMessages.map(MessageLine)  // memo'd
  │       │       ├── recentActivity.map(ActivityLine)  // memo'd
  │       │       └── isStreaming && StreamingLine      // memo'd
  │       ├── StatusLine
  │       ├── InputArea
  │       └── Footer
  └── ConfirmDialog (confirmation overlay)
```

---

## 2. All Problems Found

### 🔴 CRITICAL BUGS

#### Bug C1: User responses to agent questions not shown in chat history
**File:** `src/ui/screens/ShellScreen.tsx` — `useHandleSubmit`  
**Lines:** 142-163  
**Description:** When the agent pauses with a `human_input_required` event (type: `question` or `confirmation`), the user's typed response in the InputArea is handled by the `if (currentRequest)` branch. This branch calls `resumeWithHumanInput()` but NEVER calls `store.addUserMessage(trimmed)`. The user's answer is invisible in the chat history.

The normal path (no pending human input, line 165) correctly calls `store.addUserMessage(trimmed)`.

**Impact:** Users can't see their own responses to agent questions in the chat log.

**Fix:** Add `store.addUserMessage(trimmed)` at the start of the `if (currentRequest)` branch.

#### Bug C2: Missing `addUserMessage` causes empty input to persist in store
**File:** `src/ui/screens/ShellScreen.tsx` — `useHandleSubmit`  
**Lines:** 145-162  
**Description:** After the human input path, `store.setInput('')` is NOT called (it's only called in the normal path at line 166). So the user's input remains in the store after submission.

**Fix:** Add `store.setInput('')` in the human input response path.

#### Bug C3: Double-handling of human input responses between ConfirmDialog and ShellScreen
**Files:** `src/ui/ConfirmDialog.tsx` (line 44-65), `src/ui/screens/ShellScreen.tsx` (lines 144-162)  
**Description:** Both `ConfirmDialog` and `ShellScreen.handleSubmit` handle confirmation-type human inputs:
- `ConfirmDialog` renders a SelectInput (Yes/No) and calls `resumeWithHumanInput(approved, ...)`
- `ShellScreen.handleSubmit` also checks for `currentRequest.type === 'confirmation'` and calls `resumeWithHumanInput(answer, ...)`

If the user types "yes" in the InputArea while the dialog is visible, the ShellScreen path fires. This creates an ambiguous dual-path architecture where:
1. The ShellScreen path doesn't add the user message (`addUserMessage`)
2. The ShellScreen path doesn't clear the input
3. Both paths can theoretically race if the user interacts with both UI elements simultaneously

**Fix:** Unify human input handling. The ShellScreen path should handle text-based responses (`type === 'question'`), while the ConfirmDialog handles yes/no (`type === 'confirmation'`). The ShellScreen should NOT handle confirmation type — it should let the ConfirmDialog handle it exclusively via SelectInput.

#### Bug C4: Throttled stream may drop `human_input_required` events during error
**File:** `src/ui/screens/ShellScreen.tsx` — `createThrottledStream`  
**Lines:** 91-121  
**Description:** The `human_input_required` event is emitted by `sendSingleAgentMessage` AFTER the stream loop ends (line 1048). It goes through `emitEvent` → `stream.onEvent` → throttled buffer. If `sendMessage` throws DURING the stream loop (not after), the `human_input_required` event is never emitted because the code doesn't reach line 1048. But the graph might have already been paused at HumanIntervention. The next time the user sends a message, `isPausedAwaitingHumanInput()` would need to detect this — but currently it's only called to set up the initial state.

**Fix:** Add a `getState()` check in the catch block of `sendSingleAgentMessage` to check if the graph paused despite the stream error.

#### Bug C5: `sendSingleAgentMessage` first-message system context injection bleeds into model context permanently
**File:** `src/core/agent.ts` — `sendSingleAgentMessage`  
**Lines:** 912-928  
**Description:** On the first message, the system context (repo map + initial assistant acknowledgment) is injected as a `HumanMessage` with `[SYSTEM CONTEXT — internal, do not echo to user]` markers. This becomes part of the LangGraph checkpointed state permanently. The model sees it on every subsequent turn as part of the conversation history.

Problems:
1. The `[user]: ## REPOSITORY ARCHITECTURE MAP...` prefix confuses the role attribution — it looks like the user sent the repo map
2. On every subsequent turn, the model re-reads the repo map eating into the context window
3. The `[SYSTEM CONTEXT]` markers are a fragile string-based convention that the model may ignore

**Fix:** Inject the system context as a `SystemMessage` (not `HumanMessage`) before the model invocation. Since `systemMsg` is already prepended in the supervisor/specialist nodes, the repo map should be part of the `SystemMessage` too, or be stored as a separate LangGraph state field.

#### Bug C6: `resumeWithHumanInput` doesn't add user's answer to Zustand store messages
**File:** `src/core/agent.ts` — `resumeWithHumanInput`  
**Lines:** 430-431  
**Description:** 
```typescript
await this.persistMessages([{ content: answerText, role: 'user' }]);
await this.persistMessages([{ content: fullResponse, role: 'assistant' }]);
```
This persists to the filesystem artifacts but NOT to the Zustand store. The Zustand store is the UI's source of truth. The caller (ShellScreen or ConfirmDialog) is supposed to add the user message to the store. But:
- ConfirmDialog adds it (line 48: `addUserMessage(answerText)`)
- ShellScreen does NOT add it (see Bug C1)

**Fix:** Make the responsibility clear: `resumeWithHumanInput` should NOT add to the UI store (separation of concerns). The callers must add the user message. Fix Bug C1 in ShellScreen.

### 🟡 MEDIUM BUGS

#### Bug M1: `addActivityEvent` uses sequential counter that can produce duplicate IDs
**File:** `src/ui/store/appStore.ts` — line 167  
**Description:** 
```typescript
const counter = state.activity.length + 1;
return {
  activity: [...state.activity, { id: `a-${counter}`, ... }]
};
```
If multiple events are processed in rapid succession (throttled flush), the counter can produce duplicate IDs because `state.activity.length` might be the same for concurrent `set()` calls.

**Fix:** Use `Date.now()` + random suffix for unique IDs.

#### Bug M2: Module-level state in `human-in-loop.ts` never resets
**File:** `src/utils/human-in-loop.ts` — lines 32, 39  
**Description:** `_pendingSignature` and `_langGraphContext` are module-level variables. If the module is reused across multiple session initializations (e.g., in tests or hot-reload), stale state could cause incorrect confirmation behavior.

**Fix:** Export a `resetHumanInLoopState()` function and call it during AgentSession initialization.

#### Bug M3: `stateHashHistory` Map in workflow.ts never cleared
**File:** `src/core/graph/workflow.ts` — line 57  
**Description:** The `stateHashHistory` Map accumulates entries across all supersteps within a session. While this doesn't cause correctness issues (the Map is per-workflow instance), it grows unbounded over long sessions.

**Fix:** Periodically prune entries older than N supersteps, or use an LRU cache.

#### Bug M4: Dead code import in agent.ts
**File:** `src/core/agent.ts` — line 42  
**Description:** `streamWithContinuation` is imported from `./session.js` but never used. Only `StreamActivity` (a type) is used.

**Fix:** Remove the unused function import.

#### Bug M5: `Header.tsx` imports from wrong theme file
**File:** `src/ui/components/Header.tsx` — line 6  
**Description:** 
```typescript
import { colors, labels } from '../theme.js';
```
While other components import from `'../theme/chalkTheme.js'`. The `theme.js` file might re-export from `chalkTheme.ts`, but this inconsistency could cause issues if the re-export chain breaks.

Let me verify the actual import chains...

#### Bug M6: `OutputArea` uses `replaceAll` which requires ES2021
**File:** `src/ui/components/OutputArea.tsx` — line 247  
**Description:** `text.replaceAll(...)` requires ES2021+. The TypeScript target should be checked.

### 🟢 MINOR / ARCHITECTURAL ISSUES

#### Issue A1: Dual model systems (Vercel AI SDK + LangChain)
The codebase maintains TWO model systems:
- **Vercel AI SDK** (`ai` package): Used for `streamWithContinuation`, swarm coordinator, initial model creation
- **LangChain**: Used for LangGraph workflow (`getLangchainModel`)

Both are instantiated in `AgentSession.initialize()`:
```typescript
this.model = getModel(config);           // Vercel AI SDK model
this.langchainModel = getLangchainModel(config); // LangChain model
```

The Vercel AI SDK model (`this.model`) is used for swarm mode and passed to the swarm coordinator. The LangChain model is used for the LangGraph workflow. This duplication adds complexity and potential for inconsistency.

**Recommendation:** If LangGraph is the primary execution engine, consider removing the Vercel AI SDK dependency entirely and using LangChain throughout.

#### Issue A2: The `session.ts` module is a parallel execution path
`session.ts` provides `streamWithContinuation` which uses the Vercel AI SDK's `streamText`. This is a completely separate execution path from the LangGraph workflow. The swarm coordinator may use this, but it creates a maintenance burden.

**Recommendation:** Consolidate on LangGraph as the sole execution engine.

#### Issue A3: System prompt is injected at the node level, not the state level
The system prompt is injected as a `SystemMessage` prepended to messages in each node function:
```typescript
const messagesWithSystem = systemMsg
  ? [systemMsg, specialistMsg, ...trimmedMessages]
  : [specialistMsg, ...trimmedMessages];
```

This means the system prompt is NOT part of the LangGraph checkpointed state. If the state is loaded from a checkpoint, the system prompt is still injected fresh by the node function. This is actually the CORRECT behavior for system prompts — they should be instructions, not conversation history. But it also means the system prompt is sent to the model on EVERY node invocation, consuming tokens.

**Recommendation:** This is acceptable; system prompts should guide every model call. But consider trimming the system prompt for specialist nodes (they already have their own specialist prompts).

#### Issue A4: `trimContext` keeps the first message but doesn't guarantee it's the system context
```typescript
function trimContext(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length <= MAX_CONTEXT_MESSAGES) return messages;
  const first = messages[0];
  const recent = messages.slice(-(MAX_CONTEXT_MESSAGES - 1));
  return [first, ...recent];
}
```

The "first message" is always kept, with the assumption that it's the system context. But the first message in the LangGraph state is the HumanMessage containing the system context (injected in `sendSingleAgentMessage`). If the model ever adds a message before this, or if the checkpoint is corrupted, the wrong message would be preserved.

**Recommendation:** Tag or identify system context messages explicitly rather than relying on position.

#### Issue A5: The throttled stream flushes use `useAppStore.getState()` which bypasses React batching
```typescript
const flush = () => {
  flushTimer = null;
  const store = useAppStore.getState();
  if (chunkBuffer) {
    store.appendStreamChunk(chunkBuffer);
    chunkBuffer = '';
  }
  for (const evt of eventBuffer) store.addActivityEvent(evt);
  eventBuffer = [];
};
```

Each `store.appendStreamChunk()` and `store.addActivityEvent()` triggers a separate synchronous `set()` call in Zustand. While React 18's automatic batching should handle this, Ink uses its own React renderer which may not batch updates the same way.

**Recommendation:** Batch multiple store updates into a single `set()` call.

#### Issue A6: No error boundary for ShellScreen
If any component in the ShellScreen tree throws during rendering, there's no React Error Boundary to catch it. This could cause Ink to crash or show a blank screen, which might explain the "response disappeared and UI came back to initial state" report.

**Recommendation:** Add an error boundary around ShellScreen that catches render errors and shows a fallback UI.

#### Issue A7: `sendSingleAgentMessage` stream error handling swallows errors silently
```typescript
for await (const event of stream) {
  try {
    // ... process event
  } catch (streamError) {
    logToStderr(`[streamEvents] Error processing event: ...`);
  }
}
```

If EVERY event in the stream fails to parse, the full response would be empty. The code would still call `finishStreaming()` with empty `streamingText`, adding nothing to messages. The user would see no response and no error.

**Recommendation:** Track whether any events were successfully processed. If none were, surface an error to the UI.

---

## 3. Root Cause Analysis: "Messages Disappear After Streaming"

Based on the analysis, the most likely root causes for the reported behavior ("the response appeared well, but disappeared suddenly and the UI came back to the initial state"):

### Theory 1: Ink render crash + recovery
If a component in the OutputArea tree throws during render (e.g., due to malformed message data), Ink may crash and recover, re-rendering the app from scratch. This would explain "came back to the initial state." The crash would be invisible to the user because Ink's error handling might just re-render.

### Theory 2: Zustand state corruption from rapid updates
The throttled stream calls `appendStreamChunk` and `addActivityEvent` in rapid succession during `stream.finish()`. If a state update causes a re-render that reads stale state, components might render with inconsistent data.

### Theory 3: The `finishStreaming` race
If `stream.finish()` is called but the flush timer fires concurrently (unlikely since `clearTimeout` is called first, but...), the `streamingText` might be updated after `finishStreaming` has already moved the old `streamingText` to messages. This would result in text being left in `streamingText` (orphaned, not in messages) and the messages array having only partial text.

### Recommended diagnostic approach:
1. Add the diagnostic stderr logging already in place
2. Add a `console.error` trace in `OutputArea` when `messages.length` goes from >0 to 0
3. Add an Ink ErrorBoundary around ShellScreen
4. Log every state transition in the store (streaming, messages.length, screen)

---

## 4. Fix Plan

### Phase 1: Critical Bug Fixes (immediate)

| Bug | File | Action |
|-----|------|--------|
| C1 | `ShellScreen.tsx` | Add `store.addUserMessage(trimmed)` + `store.setInput('')` in human input response path |
| C3 | `ShellScreen.tsx` | Remove confirmation handling from ShellScreen; let ConfirmDialog handle exclusively |
| C4 | `agent.ts` | Add `getState()` check in stream error handlers to detect paused graph |
| C5 | `agent.ts` + `workflow.ts` | Move system context from HumanMessage to SystemMessage in checkpointed state |
| C6 | `ShellScreen.tsx` | Already covered by C1 fix |

### Phase 2: Robustness Improvements

| Bug | File | Action |
|-----|------|--------|
| M1 | `appStore.ts` | Use `Date.now() + Math.random()` for activity IDs |
| M2 | `human-in-loop.ts` | Export `resetHumanInLoopState()`, call on session init |
| M4 | `agent.ts` | Remove unused `streamWithContinuation` import |
| A6 | `App.tsx` | Add React Error Boundary around ShellScreen |
| A7 | `agent.ts` | Track stream event success/failure, surface errors to UI |

### Phase 3: Architectural Cleanup (separate PR)

| Issue | Action |
|-------|--------|
| A1/A2 | Consolidate on LangGraph, remove Vercel AI SDK dependency |
| A3 | Consider state-level system prompt (checkpoint-aware) |
| A4 | Tag system context messages with metadata |
| A5 | Batch Zustand updates in throttled stream flush |
