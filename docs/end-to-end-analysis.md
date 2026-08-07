# Shadow Auditor end-to-end architecture

This document describes the current production path. It is an operational
reference, not a proposal or a list of historical defects.

## Runtime path

```text
bin/run.js
  -> oclif shell command
  -> configuration and CLI override resolution
  -> Ink App
  -> repository map + AgentSession
  -> run artifacts + mission runtime
  -> Tree-sitter/lexical/vector index + knowledge graph
  -> policy-scoped tool assembly
  -> provider-neutral LangChain chat model
  -> persistent LangGraph workflow
  -> validated report artifacts and TUI/CI output
```

`src/commands/shell.tsx` parses interactive and CI flags. `src/ui/App.tsx`
resolves setup, target, diff, watch, swarm, and resume state. The
`useAgentSession` hook owns one live `AgentSession`; screen transitions do not
dispose it. Disposal is reserved for replacement or application shutdown and
aborts active work before releasing resources.

`src/core/agent.ts` is the composition boundary. It delegates indexing, tool
assembly, persistence, model construction, workflow execution, and swarm
initialization to services rather than implementing those subsystems itself.
Every run receives an isolated directory and a durable LangGraph thread.

## Deterministic audit graph

```text
START
  -> Codebase Intelligence
  -> SAST Audit
  -> Devil's Advocate
  -> Reporting
  -> END
```

The graph is deliberately sequential. Parallel discovery can occur inside
tools or swarm workers, but the publication boundary remains deterministic.

1. **Codebase Intelligence** maps entry points, trust boundaries, dependencies,
   and relevant flows.
2. **SAST Audit** produces structured candidates with exact evidence and
   source-to-sink reasoning.
3. **Devil's Advocate** independently confirms or rejects candidates. It cannot
   silently rewrite evidence identity.
4. **Reporting** consumes only validated handoffs and is the sole publisher of
   public model text.

Each stage receives a role-specific tool allowlist and step budget. One step is
one model/tool-loop iteration, regardless of how many parallel tool calls that
model response contains. Duplicate-call detection, a dynamic LangGraph
recursion ceiling, and bounded handoff repair prevent infinite loops. Handoff
repair defaults to two attempts and is configurable from zero to four. Exhausted
or invalid evidence fails closed; partial candidates are not promoted.

## Indexing and retrieval

The repository map is a fast architecture seed. The semantic index is the
evidence retrieval layer:

1. Source discovery excludes generated, dependency, and run-artifact roots.
2. Maintained Tree-sitter grammars create structural chunks. Unsupported or
   failed grammars degrade visibly to bounded whole-file chunks.
3. Content fingerprints allow unchanged vectors to survive line movement and
   subsequent runs.
4. The knowledge graph records files, chunks, declarations, containment,
   resolved local dependencies, and conservative call edges.
5. `context_retrieval` fuses available vector, lexical, and graph rankings with
   reciprocal-rank fusion.

The vector provider is probed before indexing. OpenAI-compatible embeddings and
local Ollama are supported; chat-provider support does not imply embedding
support. Failed embeddings degrade to lexical/AST/graph retrieval. Abort signals
propagate and never trigger a misleading fallback.

Community detection and hierarchical summarization exist as explicit memory
APIs, but normal startup does not currently generate community summaries.
Consequently, production documentation does not promise community-summary
retrieval.

## Provider boundary and streaming

`src/core/model-router.ts` constructs one LangChain chat-model contract for the
main graph and swarm workers. Native integrations are used for Anthropic,
Google, Mistral, Ollama, and OpenAI. DeepSeek, Qwen, Moonshot, NVIDIA,
OpenRouter, and custom endpoints use the OpenAI-compatible transport with
provider-specific history and tool-call normalization. Azure supports Azure
OpenAI and Microsoft Foundry endpoint families with API-key or Entra
authentication.

Perplexity is intentionally rejected because Sonar does not provide the
external tool contract required by this workflow. Setup model names are
suggestions, not account-availability guarantees.

The stream processor consumes LangGraph `messages` and `updates`, associates
events with stages, deduplicates usage, tool calls, and results, and checks the
checkpoint for interrupts after the stream. Reporting text is public; ordinary
stage output is activity only. Private reasoning is stripped. Azure public
reasoning summaries require explicit configuration, while DeepSeek,
OpenRouter, and Ollama reasoning channels are never rendered.

Token usage comes from provider metadata. Provider totals remain authoritative,
including cached or reasoning tokens not separately classified by a provider.
Totals are derived only from prompt and completion counters when a provider
omits its total.

## Human interaction and tool policy

File mutation and host command execution cross a confirmation boundary. Safe
mode additionally restricts commands, paths, shell composition, symlinks, and
output size. Expert mode broadens policy but does not remove confirmation.
Unanswered prompts auto-deny.

The `/tools` screen changes optional per-agent tool availability and budgets
without replacing the active session. User policy can only narrow host-owned
allowlists. Completion and handoff tools remain mandatory.

On a LangGraph interrupt, the checkpoint stores the pending request and its
identity. Resume validates that identity, records the user response, clears the
pending state, and continues the same thread. Corrupt or incompatible
checkpoints fail closed.

## Swarm and remediation

`--swarm` enables Recon, TaintTracer, ExploitAnalyst, Verifier, and Reporter
workers sharing a Blackboard. Workers use the same provider model contract,
normalized history, cancellation, usage accounting, and scoped tool executor as
the main workflow.

`--swarm --mode patch-only` runs three patch perspectives. Structured proposals
are conflict-checked, synthesized, and statically verified. Remediation remains
transactional: candidate changes are validated in a disposable workspace and
require an integrity-bound user decision before host mutation.

## Persistence and output

Runs live under `<target>/.shadow-auditor/runs/<run-id>/`. Session metadata,
messages, tool events, checkpoints, and completed pipeline artifacts are written
atomically. Markdown, JSON, and SARIF reports appear only after successful
publication. Failed and cancelled runs retain recovery evidence without being
marked complete.

CI mode uses the same graph and policies without Ink. It supports explicit
resume answers, stable finding IDs, and severity-based exit status.

## Trust boundaries

- Models are untrusted planners, not authorities.
- Tool schemas, path policy, command policy, evidence schemas, and report
  validation are deterministic host controls.
- External provider credentials and availability are deployment concerns.
- Native dependency scripts are allowed granularly by npm 11; strict consumers
  must explicitly permit required Tree-sitter builds.
- Reports are decision support and still require human review for
  release-critical findings.
