<div align="center">
  <img src="https://github.com/user-attachments/assets/df96b04f-7324-4a07-9100-ff81526e0d31" alt="Shadow Auditor">
</div>

> [!IMPORTANT]
> Shadow Auditor is under active development and may contain significant bugs. Development is currently most active on the `langgraph-migration` branch.

# 🌑 Shadow Auditor: Autonomous AI-Powered Security Analysis

> *In the realm of application security, silence is dangerous. Shadow Auditor hunts in the silence—mapping vast codebases, finding the vulnerabilities your static tools missed, and delivering evidence-backed findings that prove beyond doubt where the risk lies.*

---

## What Is Shadow Auditor?

**Shadow Auditor** is a production-grade, autonomous AI-powered SAST platform built on LangGraph. It deploys specialized AI agents that reason about your codebase, hunt vulnerabilities with methodical precision, and produce evidence-backed findings ready for CI integration and security audits.

### Core Capabilities

| Capability | Description |
|------------|-------------|
| **Codebase Mapping** | Tree-sitter AST parsing builds a compressed architecture map — every function, class, and dependency indexed |
| **Deterministic Audit Pipeline** | LangGraph executes Codebase Intelligence → SAST Audit → Devil's Advocate → Reporting with validated handoffs |
| **Hybrid Retrieval** | Semantic + lexical + knowledge-graph search via `context_retrieval` — never dump whole files |
| **Multi-Agent Swarm** | 5 specialized roles (Recon, TaintTracer, ExploitAnalyst, Verifier, Reporter) with shared Blackboard |
| **Patch Competition** | 3 competing agents propose fixes → orchestrator detects conflicts → synthesizes unified Super Patch |
| **Human-in-the-Loop** | Policy-gated tools, timeout auto-deny, decision history for intelligent re-approval |
| **CI Integration** | SARIF, JSON, Markdown reports with stable `SHADOW-<CWE>-<HEX8>` finding IDs |

---

## Quick Start

### Install from npm

```bash
npm install --global shadow-auditor
```

The package is release-ready but is **not currently published** on the public
npm registry. The command above will work after a maintainer publishes the
first release. Node.js 24 is required.

### Installation from source

```bash
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm ci
npm link
```

### Publish the prepared package

After authenticating with npm and confirming the package name is still
available:

```bash
npm test
npm pack --dry-run
npm publish --access public
```

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

Each stage has scoped tools and a finite runtime budget. Handoffs are schema-validated,
checkpointed, and repaired at most once; invalid output fails closed rather than being
published as a finding.

### Agent Intelligence System

| Feature | Description |
|---------|-------------|
| **Working Memory** | Auto-updating summary of findings, files examined, and hypotheses — survives context trimming |
| **Typed Handoffs** | Every stage consumes the validated, persisted artifact from the preceding stage |
| **Evidence Review** | Devil's Advocate independently confirms or rejects every candidate finding |
| **Durable Resume** | Checkpoints preserve artifacts and confirmation identity across interrupted runs |
| **Bounded Execution** | Duplicate-call detection and model-aware tool budgets force a final synthesis |

### Tool Intelligence

Every tool is designed for maximum agent efficiency:

| Tool | Enhancement |
|------|-------------|
| `context_retrieval` | Hybrid semantic+lexical+graph search. Clean output format with chaining hints |
| `search_codebase` | Results grouped by file with match counts. Shows top matches, hides noise |
| `read_file_content` | **Line-range reads** (`startLine`/`endLine`). Auto-overview for large files. 40x token savings |
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
- ExploitAnalyst: `query_claims` → `read_file` → `context_retrieval` mitigations → classify CWE
- Verifier: `query_claims` → `read_file` → `context_retrieval` → `verify_claim`/`contest_claim`
- Reporter: `query_claims` → organize by severity → `finish_task`

### Patch Competition & Orchestrator Engine

Three co-equal agents produce competing patches. The orchestrator resolves conflicts:

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
| **Decision History** | Previously approved operations auto-approved for 1 hour |
| **Timeout** | 5-minute auto-deny for unanswered confirmations |
| **Signature Tracking** | Same tool called again after resume returns `true` without re-prompting |
| **LangGraph Command** | Tools throw `Command` → graph pauses at `HumanIntervention` → TUI shows question |

---

## Provider Ecosystem

Shadow Auditor is provider-agnostic. Use any supported AI provider:

| Provider | Models | Notes |
|----------|--------|-------|
| **Anthropic** | Claude 5 Fable, Claude 4.6/4.7/4.8 Opus | Security-optimized |
| **OpenAI** | GPT-5, GPT-5.4, o1, o3 | Broad capability |
| **Google** | Gemini 3.1 Pro, Gemini 3/3.5 Flash | High throughput |
| **Mistral** | Mistral Large, Codestral | Cost-effective |
| **DeepSeek** | DeepSeek-V4-Pro, DeepSeek-R1 | OpenAI-compatible |
| **Ollama** | Llama 3, Qwen 2.5, CodeQwen | Local, privacy-first |
| **Custom** | Any OpenAI-compatible endpoint | Bring your own |

---

## Output & Artifacts

Every run produces a persistent artifact folder:

```
<target>/.shadow-auditor/runs/<ISO-timestamp>-<id>/
├── session-meta.json      # Run metadata, config, timing
├── messages.jsonl         # Complete conversation history
├── tool-events.jsonl      # All tool invocations and results
├── report.json            # Structured findings (deduplicated, stable IDs)
├── report.sarif           # SARIF for GitHub Code Scanning / GitLab
├── report.md              # Human-readable Markdown
└── langgraph-checkpoints/ # LangGraph state checkpoints
```

**Stable Finding IDs:** `SHADOW-<CWE>-<HEX8>` — deterministic, reproducible, derived from title + CWE + file path + evidence.

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

API keys are stored in the OS keychain (via `keychain` adapter). For backward compatibility, keys may also be read from the config file.

---

## Requirements

- **Node.js** >= 24 and < 25
- **npm** (or pnpm/yarn)
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

- **Command Policy**: Safe families by default (`git status`, `npm test`). Destructive patterns denied.
- **Expert Mode** (`--expert-unsafe`): Broader capabilities with explicit warnings.
- **Confirmation Gates**: File edits and command execution require explicit approval.
- **Timeouts**: Unanswered confirmations auto-deny after 5 minutes.
- **Decision History**: Repeated similar operations auto-approved within 1 hour.

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
