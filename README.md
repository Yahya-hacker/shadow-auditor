<div align="center">
  <img src="https://github.com/user-attachments/assets/df96b04f-7324-4a07-9100-ff81526e0d31" alt="Shadow Auditor">
</div>

> [!IMPORTANT]
> Shadow Auditor 1.0 is a release candidate. Its release gate covers Node 24,
> native Tree-sitter loading, the complete test/lint/build pipeline, clean
> tarball installation, and CLI smoke tests. Pin the version in automated
> environments and validate the selected external model provider before rollout.

# 🌑 Shadow Auditor: Autonomous AI-Powered Security Analysis

> *In the realm of application security, silence is dangerous. Shadow Auditor hunts in the silence—mapping vast codebases, finding the vulnerabilities your static tools missed, and delivering evidence-backed findings that prove beyond doubt where the risk lies.*

---

## What Is Shadow Auditor?

**Shadow Auditor** is an autonomous AI-powered SAST CLI built on LangGraph. It
deploys specialized agents that inspect code, challenge vulnerability
candidates, and produce evidence-backed findings for CI and human review.

### Core Capabilities

| Capability | Description |
|------------|-------------|
| **Codebase Mapping** | Tree-sitter AST parsing indexes supported structural declarations plus resolved import and call relationships; unavailable grammars are reported explicitly |
| **Deterministic Audit Pipeline** | LangGraph executes Codebase Intelligence → SAST Audit → Devil's Advocate → Reporting with validated handoffs |
| **Hybrid Retrieval** | Semantic + lexical + knowledge-graph search via `context_retrieval`, followed by targeted line-range reads |
| **Multi-Agent Swarm** | 5 specialized roles (Recon, TaintTracer, ExploitAnalyst, Verifier, Reporter) with shared Blackboard |
| **Patch Competition** | In swarm `patch-only` mode, 3 perspective-specific agents propose fixes → orchestrator detects conflicts → synthesizes a unified candidate patch |
| **Human-in-the-Loop** | Policy-gated tools, per-operation approval, and timeout auto-deny |
| **CI Integration** | SARIF, JSON, Markdown reports with stable `SHADOW-<CWE>-<HEX8>` finding IDs |

---

## Quick Start

### Install from npm

```bash
npm install --global shadow-auditor --allow-scripts=@tree-sitter-grammars/tree-sitter-markdown,@tree-sitter-grammars/tree-sitter-toml,@tree-sitter-grammars/tree-sitter-yaml,tree-sitter,tree-sitter-c,tree-sitter-c-sharp,tree-sitter-cpp,tree-sitter-elixir,tree-sitter-go,tree-sitter-haskell,tree-sitter-html,tree-sitter-java,tree-sitter-javascript,tree-sitter-json,tree-sitter-php,tree-sitter-python,tree-sitter-ruby,tree-sitter-rust,tree-sitter-scala,tree-sitter-typescript,unrs-resolver
```

The package is release-ready but is **not currently published** on the public
npm registry. The command above will work after a maintainer publishes the
first release. Node.js 24 and npm 11 are required. npm intentionally makes the
installer choose which dependency lifecycle scripts may run; the explicit
allowlist permits only Shadow Auditor's native parsers and resolver. A
dependency cannot silently weaken the consuming project's install policy.

### Installation from source

```bash
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm ci
npm link
```

To refresh an existing source checkout and its global link, use:

```bash
npm run relink
```

This installs with the committed lifecycle policy, runs a real AST parse across
every guaranteed production grammar, and then refreshes the global link.

Do not use `npm unlink shadow-auditor` for this workflow. npm treats that
command as a local package uninstall, not as removal of the global link, and
npm 11 may consequently print misleading `allow-scripts` warnings while it
reifies the local dependency tree. The following `npm install` still applies
the committed `package.json#allowScripts` policy, but the uninstall step is
unnecessary. To remove the global link intentionally, use
`npm unlink --global shadow-auditor` with a user-owned npm prefix or the
permissions required by your global npm directory.

### Publish the prepared package

Production publication is performed only by
`.github/workflows/release.yml`. A maintainer creates a protected GitHub
release from protected `main` whose tag exactly matches
`v<package.json version>` (for example, `v1.0.0`). The unprivileged verification
job audits and tests the source, builds one tarball, and uploads it before any
packaged code executes. A separate unprivileged job downloads and smoke-tests
that immutable artifact in a clean consumer with the native parser allowlist.
The publication job has no checkout, dependency install, or package lifecycle
execution; it verifies the artifact digest, package identity, version, and
registry, then publishes that same tarball to npmjs.org with npm provenance.

Configure npm trusted publishing for this repository, workflow, and the
protected `npm` GitHub environment. For the first publication only, when npm
cannot yet associate a trusted publisher with the unpublished package, place a
granular publish-only `NPM_TOKEN` in that environment. Remove the token after
trusted publishing is configured; subsequent releases use GitHub OIDC.

### First Run

```bash
shadow-auditor
```

The setup wizard guides you through provider selection, API key configuration, and target directory. After initialization, you enter the interactive security shell.

### Interactive Shell

```
Shadow Auditor ❯ Find all SQL injection vulnerabilities
Shadow Auditor ❯ Analyze the authentication middleware
Shadow Auditor ❯ Search for hardcoded secrets
Shadow Auditor ❯ Review file validation logic
Shadow Auditor ❯ Run a full audit
```

Exit with `exit`, `quit`, or `Ctrl+C`.

---

## CLI Options

```bash
shadow-auditor [flags]

FLAGS
  --mode=<mode>           Audit mode: triage|deep-sast|full-report|patch-only|balanced
  --diff                  Incremental scan: only files changed since --since ref
  --since=<ref>           Git ref for incremental base (default: HEAD~1)
  --ci                    CI mode: deterministic output, exit code on severity
  --fail-on=<severity>    Minimum severity for non-zero CI exit (critical|high|medium|low|none)
  --resume-run=<id>       Resume a persisted LangGraph run
    --resume[=<id>]         Alias for --resume-run; bare --resume resumes the most recent run
    --prompt=<text>         CI mission, or explicit answer for a paused resumed run
  --target=<path>         Repository to audit (default: current directory)
  --expert-unsafe         Permit broader command and MCP tool execution surface
  --swarm                 Enable multi-agent swarm mode for parallel analysis
  --watch                 Monitor source changes and run serialized incremental audits
  --reconfigure           Force the configuration wizard to run again
```

### Examples

```bash
# Interactive shell with full analysis
shadow-auditor --mode deep-sast

# Fast triage pass
shadow-auditor --mode triage

# CI pipeline: incremental scan, fail on high+
shadow-auditor --ci --diff --since main --fail-on high

# Resume a paused headless run with its required confirmation
shadow-auditor --ci --resume-run <run-id> --prompt yes

# Resume the most recent run (interactive)
shadow-auditor --resume

# Resume a specific run after Ctrl+C / an interruption; the tool prints this
# command on shutdown so no session is ever lost
shadow-auditor --resume <run-id>

# Multi-agent swarm mode
shadow-auditor --swarm

# Continuously audit security-relevant source changes
shadow-auditor --watch

# Expert mode with broader tool access
shadow-auditor --expert-unsafe
```

---

## Architecture

### LangGraph Workflow

```
START
  │
  ▼
Codebase Intelligence ── repository map + architecture report
  │
  ▼
SAST Audit ────────────── evidence-backed candidate findings
  │
  ▼
Devil's Advocate ──────── confirmed/rejected findings with rationale
  │
  ▼
Reporting ─────────────── final Markdown and bug-bounty reports
  │
  ▼
END
```

**Key nodes:**
- **Codebase Intelligence** — Maps architecture, trust boundaries, entry points, and data flows.
- **SAST Audit** — Traces vulnerability sources to sinks and records code evidence.
- **Devil's Advocate** — Challenges exploitability and rejects unsupported claims.
- **Reporting** — Produces the only public model response, with clear impact, reproduction steps, and PoC evidence.

Each stage has scoped tools and a finite runtime budget. Handoffs are schema-validated
and checkpointed. Invalid handoffs fail closed after a bounded repair policy: two
repair attempts by default, configurable from 0 to 4 with
`reportValidation.maxRepairRetries`.

### Agent Intelligence System

| Feature | Description |
|---------|-------------|
| **Working Memory** | Auto-updating summary of findings, files examined, and hypotheses — survives context trimming |
| **Typed Handoffs** | Each downstream stage consumes the validated, persisted artifact from its predecessor |
| **Evidence Review** | Devil's Advocate independently confirms or rejects every candidate finding |
| **Durable Resume** | Checkpoints preserve artifacts and confirmation identity across interrupted runs |
| **Bounded Execution** | Duplicate-call detection and model-aware tool budgets force a final synthesis |

Tool autonomy is configurable without bypassing host policy. Enter `/tools` in the
interactive shell to open the dedicated tool screen, select an agent, enable or
disable optional tools, and set its tool-step budget from 8 to 1024. Mandatory
handoff and completion tools remain enabled. A step is one model/tool-loop
iteration; parallel calls emitted by one model response consume one step.

### Tool Intelligence

The agent tools expose bounded, composable operations:

| Tool | Enhancement |
|------|-------------|
| `context_retrieval` | Hybrid semantic+lexical+graph search. Clean output format with chaining hints |
| `search_codebase` | Results grouped by file with match counts. Shows top matches, hides noise |
| `read_file_content` | Line-range reads (`startLine`/`endLine`) and an automatic structural overview for large files |
| `list_directory` | Structured output: directories first, file counts, chaining hints |
| `execute_command` | Policy-gated host command execution with approval, timeout, and output limits |
| `edit_file` | Exact-match validation, confirmation flow, line-change summary |
| `finish_task` | Pre-call checklist, structured summary format |

### Multi-Agent Swarm

```
┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────┐  ┌──────────┐
│  RECON   │  │ TAINT TRACER │  │EXPLOIT ANALYST│  │ VERIFIER │  │ REPORTER │
│ discover │  │  trace data  │  │  classify CWE │  │ validate │  │ compile  │
│ entries  │  │  source→sink │  │  assess risk  │  │ findings │  │  report  │
└────┬─────┘  └──────┬───────┘  └───────┬───────┘  └────┬─────┘  └────┬─────┘
     │               │                  │               │            │
     └───────────────┴──────────────────┴───────────────┴────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │    BLACKBOARD     │
                          │ claims · conflicts│
                          │ consensus · tasks │
                          └───────────────────┘
```

Each role has a **recommended tool workflow** to minimize thrashing:
- Recon: `list_directory` → `context_retrieval` → `execute_command` → `submit_claim`
- TaintTracer: `query_claims` → `context_retrieval` per entry → `search_codebase` → `submit_claim`
- ExploitAnalyst: `query_claims` → `read_file_content` → `context_retrieval` mitigations → classify CWE
- Verifier: `query_claims` → `read_file_content` → `context_retrieval` → `verify_claim`/`contest_claim`
- Reporter: `query_claims` → organize by severity → `finish_task`

### Patch Competition & Orchestrator Engine

With `--swarm --mode patch-only`, three co-equal agents produce competing
patch proposals from security-boundary, language-pattern, and TUI-state-machine
perspectives. The orchestrator resolves conflicts:

```
Agent A (Security)  ──► PatchProposal ──┐
Agent B (Language)  ──► PatchProposal ──┼──► OrchestratorEngine
Agent C (TUI Logic) ──► PatchProposal ──┘      │
                                               ├─ detectConflicts()
                                               ├─ synthesizePatches()
                                               ├─ verifySynthesizedPatch()
                                               │
                                               ▼
                                          Super Patch
                                     (unified git diff)
```

**Conflict detection** parses unified diffs into structured hunks, detects 5 conflict types (`same_line_edit`, `adjacent_edit`, `semantic_conflict`, `import_header_conflict`, `test_conflict`), and assigns resolution strategies.

**Patch synthesis** merges non-conflicting hunks. For conflicts, applies resolution strategies: `merge_both`, `prefer_security`, `prefer_performance`, `combine_alternating`, or `manual_required` (with conflict markers).

**Logical verification** runs 7 static checks: syntax validity, import completeness, type consistency, control flow integrity, idiom preservation, interface bridge integrity, and test compatibility.

### Human-in-the-Loop

| Feature | Behavior |
|---------|----------|
| **Single-use Decisions** | Every side-effecting operation requires a fresh approval |
| **Timeout** | 5-minute auto-deny for unanswered confirmations |
| **Signature Tracking** | A signature binds one pending operation to its resume response; it is cleared after that decision |
| **LangGraph Command** | Tools throw `Command` → graph pauses at `HumanIntervention` → TUI shows question |

---

## Provider Ecosystem

Shadow Auditor supports the providers below. Model names are setup-wizard
examples, not a guarantee that a provider account has access to that model;
custom model names are accepted where the provider API supports them.

| Provider | Models | Notes |
|----------|--------|-------|
| **Anthropic** | Claude Sonnet 4, Claude Opus 4, Claude Haiku/Sonnet 3.5 | Native Anthropic API |
| **Azure / Microsoft Foundry** | GPT-5.6 Sol, GPT-5.4, GPT-5.x, GPT-4.1 | API key or Entra authentication; deployment names are configurable |
| **OpenAI** | GPT-4o, GPT-4o mini, GPT-4.1, o1, o3-mini | Native OpenAI API |
| **Google** | Gemini 3.6/3.5 Flash, Gemini 2.5 Pro | Native Google API |
| **Mistral** | Mistral Large/Medium/Small, Codestral | Native Mistral API |
| **DeepSeek** | DeepSeek V4 Pro/Flash | OpenAI-compatible transport with reasoning normalization |
| **Qwen** | Qwen Plus/Turbo/Max/Coder Plus | DashScope OpenAI-compatible transport |
| **Moonshot** | Kimi K3, Kimi K2.7 Code, Kimi K2.6 | OpenAI-compatible transport |
| **NVIDIA** | Llama 3.1, Nemotron 4 | NVIDIA OpenAI-compatible transport |
| **OpenRouter** | OpenRouter Auto and routed vendor models | OpenAI-compatible transport |
| **Ollama** | Llama 3.1, Qwen 2.5 Coder | Local, privacy-first |
| **Custom** | Any OpenAI-compatible endpoint | Bring your own |

Perplexity Sonar is intentionally not offered by the setup wizard because its
chat API does not expose the external tool contract required by the
deterministic pipeline.

Provider payload, schema, tool-loop, replay, and error contracts are covered by
the automated test suite. Microsoft Foundry with Entra authentication has also
been exercised live against `gpt-5.6-sol`; other hosted providers require
customer credentials and should be smoke-tested in the deployment environment.

### Streaming, reasoning, and token accounting

- LangGraph `messages` and `updates` are the runtime stream contract. Provider
  chunks are normalized before they reach the TUI.
- The Reporting stage is the only source of public report text. Private chain of
  thought is not rendered. Azure/Foundry reasoning summaries are shown only when
  `azure.reasoningSummary` explicitly enables the endpoint's public summary
  feature; DeepSeek, OpenRouter, and Ollama reasoning channels remain private.
- Native Anthropic signed thinking blocks and Google thought signatures are
  preserved for valid provider replay without exposing them in the transcript.
- Token counters use provider-reported usage metadata when available. A total is
  derived only when the provider supplies prompt/completion counts but no total.
  Provider totals that include cached, reasoning, or otherwise unclassified
  tokens are preserved rather than rewritten, and the TUI labels their
  provenance.

---

## Output & Artifacts

Every started run creates a persistent artifact folder and
`session-meta.json`. Message and tool-event logs are appended when those events
occur. Pipeline handoffs and final reports are written only after their
respective stages complete; cancelled or failed runs intentionally retain
partial recovery evidence without masquerading as completed reports.

```
<target>/.shadow-auditor/runs/<ISO-timestamp>-<id>/
├── session-meta.json      # Provider/model, target, budgets, warnings, timestamps
├── messages.jsonl         # Messages recorded so far (when present)
├── tool-events.jsonl      # Tool calls/results recorded so far (when present)
├── pipeline/              # Completed typed stage handoffs (when present)
├── report.json            # Completed structured findings
├── report.sarif           # Completed SARIF export
├── report.md              # Completed human-readable report
└── langgraph-checkpoints/ # Persisted LangGraph state
```

**Stable Finding IDs:** `SHADOW-<CWE>-<HEX8>` — deterministic and derived
from normalized title, CWE, primary file, symbol, and line numbers.

---

## Configuration

Saved to `~/.shadow-auditor.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "apiKey": "",
  "auditMode": "deep-sast",
  "indexing": {
    "enabled": true,
    "embeddingProvider": "openai",
    "embeddingModel": "text-embedding-3-small"
  }
}
```

For private local indexing, set `embeddingProvider` to `ollama`. The index honors
`OLLAMA_HOST`; `indexing.embeddingBaseUrl` can override it, and
`indexing.embeddingDimension` must match the selected embedding model (768 for
the default `nomic-embed-text`). Ollama requests are batched and response vectors
are validated before the active index is replaced.

OpenAI-compatible cloud embeddings are currently verified for OpenAI and NVIDIA.
Other chat providers do not imply an embeddings API; configure an explicit
OpenAI-compatible embedding endpoint or use Ollama. Startup probes validate the
selected provider. If embeddings are unavailable, Shadow Auditor reports the
degradation and continues with Tree-sitter, lexical, and knowledge-graph
retrieval. Cancellation is never converted into a fallback.

The content-addressed semantic index is stored under
`<target>/.shadow-auditor/semantic-index` and reuses unchanged vectors. Supported
Tree-sitter grammars provide structural chunks, imports, and conservative call
edges. Missing or failed grammars are visible in indexing diagnostics and fall
back to bounded whole-file lexical chunks; relationships are never guessed
between ambiguous symbols.

API keys are stored in the OS keychain (via `keychain` adapter). For backward compatibility, keys may also be read from the config file.

---

## Requirements

- **Node.js** >= 24 and < 25
- **npm 11** (the lockfile and native-install allowlist are npm-managed)
- Optional: **Ollama** for local embeddings (`ollama pull nomic-embed-text`)

---

## Development

```bash
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm install
npm run build        # Compile TypeScript
npm test             # Run tests, then lint
npm run lint         # ESLint
```

### Project Structure

```
src/
├── commands/shell.tsx         # CLI entry point (oclif)
├── core/
│   ├── agent.ts               # AgentSession — runtime composition
│   ├── system-prompt.ts       # System prompt builder with working memory
│   ├── services/              # Tool assembly, execution, persistence
│   ├── model-router.ts        # LangChain provider instantiation
│   ├── model-capabilities.ts  # Runtime setting resolution
│   ├── graph/
│   │   ├── workflow.ts        # Deterministic four-stage LangGraph pipeline
│   │   ├── state.ts           # AgentState annotations
│   │   ├── tool-retriever.ts  # Dynamic top-K tool selection
│   │   └── tools/
│   │       └── langchain-wrapper.ts  # AI SDK → LangChain adapter
│   ├── tools/                 # Policy-scoped agent tools
│   │   ├── context-retrieval.ts
│   │   ├── edit-file.ts
│   │   ├── execute-command.ts
│   │   ├── finish-task.ts
│   │   ├── list-directory.ts
│   │   ├── read-file.ts
│   │   └── search-codebase.ts
│   ├── hivemind/              # Multi-agent swarm
│   │   ├── swarm-supervisor.ts
│   │   ├── swarm-coordinator.ts
│   │   ├── agent-worker.ts
│   │   ├── blackboard.ts
│   │   ├── task-graph.ts
│   │   ├── consensus.ts
│   │   ├── worker-prompts.ts
│   │   └── worker-toolsets.ts
│   ├── orchestrator/          # Patch competition engine
│   │   ├── orchestrator-engine.ts
│   │   ├── patch-competition-schema.ts
│   │   ├── patch-conflict-detector.ts
│   │   ├── patch-synthesizer.ts
│   │   └── patch-logical-verifier.ts
│   ├── memory/                # Hybrid retrieval + knowledge graph
│   │   ├── hybrid-retriever.ts
│   │   ├── knowledge-graph.ts
│   │   ├── semantic-index.ts
│   │   └── vector-store.ts
│   ├── output/                # Report generation
│   │   ├── report-builder.ts
│   │   ├── sarif.ts
│   │   ├── dedup.ts
│   │   └── ci-exit.ts
│   └── policy/                # Safety guardrails
│       ├── command-policy.ts
│       └── path-guard.ts
├── ui/                        # Ink React TUI
│   ├── App.tsx
│   ├── screens/               # ShellScreen, BootScreen, SetupScreen
│   ├── components/            # OutputArea, InputArea, Header, etc.
│   └── store/appStore.ts      # Zustand state management
└── utils/
    ├── human-in-loop.ts       # Confirmation flow with timeout
    ├── config.ts              # Configuration persistence
    └── keychain.ts            # OS keychain adapter
```

---

## Safety & Governance

- **Review Boundary**: Model output can miss vulnerabilities; treat reports as
  decision support and retain human review for release-critical findings.
- **Command Policy**: Safe families by default (`git status`, `npm test`). Destructive patterns denied.
- **Expert Mode** (`--expert-unsafe`): Broader capabilities with explicit warnings.
- **Confirmation Gates**: File edits and every host command execution require explicit approval.
- **Timeouts**: Unanswered confirmations auto-deny after 5 minutes.
- **Single-use Decisions**: A resumed approval authorizes exactly the pending operation; identical later operations prompt again.

---

## License

The source code is distributed under the [MIT License](LICENSE).

Paid feature licenses are validated through Polar. Distributors enabling paid
tiers must set `SHADOW_POLAR_ORG_ID` to the issuing Polar organization ID;
without it, paid modes fail closed with an explicit configuration error.

---

## Repository

[Yahya-hacker/shadow-auditor](https://github.com/Yahya-hacker/shadow-auditor)

---

*Shadow Auditor: Autonomous security for teams that demand evidence.*
