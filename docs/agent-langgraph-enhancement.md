# LangGraph execution and provider contract

This reference records the invariants that future changes must preserve.

## Execution invariants

1. The main workflow remains Codebase Intelligence -> SAST Audit -> Devil's
   Advocate -> Reporting.
2. A downstream stage consumes the validated persisted artifact from its
   predecessor, not free-form transcript text.
3. Reporting is the only public model-output boundary.
4. Every stage has a finite step budget. A model response containing parallel
   tool calls consumes one step.
5. Duplicate tool calls, handoff repair, and graph recursion are independently
   bounded.
6. Invalid evidence and exhausted repair fail closed.
7. Checkpoints and report artifacts are durable before a run is marked
   complete.
8. Cancellation propagates through models, embeddings, tools, DAST,
   remediation, MCP, and swarm workers.

## State and context

The graph state includes the mission, conversation messages, working memory,
stage iterations, typed handoffs, evidence actions, candidate findings,
verdicts, report text, and pending human input.

Working memory preserves progress across context compaction. Provider history
normalization must keep every assistant tool call paired with exactly one tool
result. Native signed reasoning content may be retained only when the same
provider requires it for replay; portable history strips private reasoning.

System and specialist prompts are injected at invocation time instead of being
stored as user messages. Repository context is represented by the repository
map, indexing summary, working memory, and targeted retrieval.

## Provider adapter rules

All execution paths consume a LangChain-compatible chat model and the shared
tool executor. A provider adapter is complete only when it handles:

- endpoint and authentication construction;
- strict tool-schema binding;
- streamed and non-streamed assistant messages;
- tool-call normalization and stable call IDs;
- assistant/tool history replay;
- provider errors and cancellation;
- usage metadata normalization;
- private-reasoning handling.

Native adapters are preferred where they preserve provider semantics. An
OpenAI-compatible transport is acceptable only with explicit fixtures for that
provider's deviations. Cross-package type differences must be isolated in the
model router rather than spread through agents.

Perplexity Sonar is unsupported until it offers the external tool contract
required by the graph. Model suggestions in setup are examples and must never
be described as entitlement or live availability.

## Streaming and reasoning privacy

The runtime consumes LangGraph `messages` and `updates`, not raw provider SDK
events as a public API. Stream handling must:

- preserve stage and tool causality;
- emit each tool call, result, and usage record once;
- recover pending interrupts from the checkpoint after stream failure;
- reject an empty stream that produced no processable event;
- filter DeepSeek DSML protocol fragments;
- keep private chain of thought out of activity and reports.

Azure/Foundry public reasoning summaries require explicit
`azure.reasoningSummary` configuration. DeepSeek, OpenRouter, and Ollama
reasoning must remain private. Anthropic signed thinking and Google thought
signatures may be preserved internally for replay but are not rendered.

## Token accounting

Provider totals are authoritative. Prompt and completion counters are recorded
when supplied; their sum is used only when no total exists. A positive
difference between the provider total and classified counters is retained as
`unclassified`, covering cached, reasoning, audio, or future token categories
without inventing a classification.

Usage events must be deduplicated at the durable message/event boundary.
Estimated text length is not token accounting and must not be presented as
provider usage.

## Tool autonomy

Default step budgets are intentionally generous and configurable from 8 to
1024 globally or per agent. The `/tools` screen provides the interactive
control plane. These controls can narrow, not widen, the role and host policy:

- optional tools may be enabled or disabled;
- per-agent budgets may be changed;
- mandatory completion and evidence-handoff tools cannot be disabled;
- command and path policy remain host-owned;
- mutations and host commands retain human confirmation.

Increasing a budget does not weaken duplicate-call detection, report
validation, cancellation, or the graph recursion ceiling.

## Retrieval contract

`context_retrieval` uses reciprocal-rank fusion across strategies that actually
have data:

- vector similarity when a validated embedding provider is available;
- in-process lexical matching over indexed chunks;
- label and relationship search over the knowledge graph.

Tree-sitter extraction is structural evidence, not proof of a vulnerability.
Dependency resolution is local and call edges are added only when a target is
unambiguous. Missing grammars and embedding outages must produce diagnostics
and a bounded fallback. Cancellation must never be swallowed as degradation.

The codebase contains community-detection and summarization APIs, but startup
does not currently materialize community summaries. Do not advertise that
strategy as active until generation, persistence, invalidation, cost controls,
and regression coverage are wired end to end.

## Durable human interaction

Interrupts carry a request identity and are checkpointed. Resume must verify
the current checkpoint request, reject stale answers, persist the user's
response, clear the pending state, and continue the same thread. UI navigation
must not dispose the session.

Each confirmation signature binds one pending operation to its resume response
and is cleared after the decision; there is no reusable approval history.
Timeouts deny rather than approve. Safe mode rejects destructive commands,
unsafe shell composition, host-path escape, and symlink traversal before
execution.

## Required validation for provider or graph changes

Run the smallest focused tests first, then the complete release gate:

```bash
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

Provider changes require deterministic stream, tool, replay, usage, error, and
cancellation fixtures. Native parser or packaging changes additionally require
clean tarball installation, global CLI smoke, isolated `npm link`, and a real
Tree-sitter parse.
