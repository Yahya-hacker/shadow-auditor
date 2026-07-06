<div align="center">
  <img src="https://github.com/user-attachments/assets/df96b04f-7324-4a07-9100-ff81526e0d31" alt="Shadow Auditor">
</div>

# 🌑 Shadow Auditor: Autonomous AI-Powered Security Analysis

> *In the realm of application security, silence is dangerous. Shadow Auditor hunts in the silence—mapping vast codebases, finding the vulnerabilities your static tools missed, and delivering evidence-backed findings that prove beyond doubt where the risk lies.*

---

## What Is Shadow Auditor?

**Shadow Auditor** is a production-grade, autonomous AI-powered SAST platform built on LangGraph. It deploys specialized AI agents that reason about your codebase, hunt vulnerabilities with methodical precision, and produce evidence-backed findings ready for CI integration and security audits.

### Core Capabilities

| Capability | Description |
|------------|-------------|
| **Codebase Mapping** | Tree-sitter AST parsing builds a compressed architecture map — every function, class, and dependency indexed |
| **Autonomous Agents** | LangGraph StateGraph with Supervisor + Specialists (SAST, GraphTracer, Verifier) + Reflector self-review |
| **Hybrid Retrieval** | Semantic + lexical + knowledge-graph search via `context_retrieval` — never dump whole files |
| **Multi-Agent Swarm** | 5 specialized roles (Recon, TaintTracer, ExploitAnalyst, Verifier, Reporter) with shared Blackboard |
| **Patch Competition** | 3 competing agents propose fixes → orchestrator detects conflicts → synthesizes unified Super Patch |
| **Human-in-the-Loop** | Policy-gated tools, timeout auto-deny, decision history for intelligent re-approval |
| **CI Integration** | SARIF, JSON, Markdown reports with stable `SHADOW-<CWE>-<HEX8>` finding IDs |

---

## Quick Start

### Installation

```bash
npm install -g shadow-auditor
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
  --expert-unsafe         Permit broader command and MCP tool execution surface
  --swarm                 Enable multi-agent swarm mode for parallel analysis
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

# Multi-agent swarm mode
shadow-auditor --swarm

# Expert mode with broader tool access
shadow-auditor --expert-unsafe
```

---

## Architecture

### LangGraph Workflow

```
                        ┌─────────────┐
                        │    START     │
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │  Supervisor │◄──────────────────────┐
                        └──┬───┬───┬──┘                       │
                           │   │   │                          │
              ┌────────────┼───┘   └────────────┐             │
              │            │                    │             │
     ┌────────▼───┐ ┌──────▼──────┐ ┌──────────▼──┐  ┌───────┴──────┐
     │SastAnalyzer│ │ GraphTracer │ │  Verifier   │  │   Reflector  │
     └──────┬─────┘ └──────┬──────┘ └──────┬──────┘  └──────┬───────┘
            │              │               │                │
            └──────────────┼───────────────┘                │
                           │                                │
                    ┌──────▼──────┐                   ┌─────▼──────┐
                    │ToolExecutor │                   │ PASS → END │
                    └──────┬──────┘                   │RETRY → Sup │
                           │                          └────────────┘
                    ┌──────▼──────────┐
                    │HumanIntervention│
                    │  (interrupt)    │
                    └─────────────────┘
```

**Key nodes:**
- **Supervisor** — Main orchestrator: decides what to do next, delegates to specialists
- **SastAnalyzer** — Static analysis specialist: injection, auth, crypto, input validation
- **GraphTracer** — Data flow tracer: sources → sinks, taint propagation
- **Verifier** — Anti-hallucination: confirms findings with code evidence
- **Reflector** — Self-review: checks output quality, routes back for improvement if needed
- **ToolExecutor** — Executes tool calls: search, read, edit, bash
- **HumanIntervention** — Pause point for confirmations (interruptBefore)

### Agent Intelligence System

| Feature | Description |
|---------|-------------|
| **Working Memory** | Auto-updating summary of findings, files examined, and hypotheses — survives context trimming |
| **Context Summarization** | When messages exceed 30, older context is compressed into working memory instead of discarded |
| **Reflection Loop** | Every model output is reviewed for completeness, evidence quality, and hallucination risk |
| **Dynamic System Prompt** | Working memory injected before each model call — agent always knows the current state |
| **Tool Strategy Phases** | Discovery → Deep Analysis → Modification → Termination with anti-pattern warnings |

### Tool Intelligence

Every tool is designed for maximum agent efficiency:

| Tool | Enhancement |
|------|-------------|
| `context_retrieval` | Hybrid semantic+lexical+graph search. Clean output format with chaining hints |
| `search_codebase` | Results grouped by file with match counts. Shows top matches, hides noise |
| `read_file_content` | **Line-range reads** (`startLine`/`endLine`). Auto-overview for large files. 40x token savings |
| `list_directory` | Structured output: directories first, file counts, chaining hints |
| `bash` | Truncated output at 100 lines, actionable narrowing tips |
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
- Recon: `list_directory` → `context_retrieval` → `bash` → `submit_claim`
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
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus | Security-optimized |
| **OpenAI** | GPT-4o, GPT-4, o1, o3 | Broad capability |
| **Google** | Gemini 1.5 Pro, Gemini 2.0 Flash | High throughput |
| **Mistral** | Mistral Large, Codestral | Cost-effective |
| **DeepSeek** | DeepSeek-V3, DeepSeek-R1 | OpenAI-compatible |
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

API keys are stored in the OS keychain (via `keychain` adapter). For backward compatibility, keys may also be read from the config file.

---

## Requirements

- **Node.js** >= 24.14.1
- **npm** (or pnpm/yarn)
- Optional: **Ollama** for local embeddings (`ollama pull nomic-embed-text`)

---

## Development

```bash
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm install
npm run build        # Compile TypeScript
npm test             # Run test suite (347 tests)
npm run lint         # ESLint
```

### Project Structure

```
src/
├── commands/shell.tsx         # CLI entry point (oclif)
├── core/
│   ├── agent.ts               # AgentSession — main agent orchestrator
│   ├── system-prompt.ts       # System prompt builder with working memory
│   ├── session.ts             # Vercel AI SDK session (swarm workers)
│   ├── model-router.ts        # Multi-provider model instantiation
│   ├── model-capabilities.ts  # Runtime setting resolution
│   ├── graph/
│   │   ├── workflow.ts        # LangGraph StateGraph (8 nodes)
│   │   ├── state.ts           # AgentState annotations
│   │   ├── tool-retriever.ts  # Dynamic top-K tool selection
│   │   └── tools/
│   │       └── langchain-wrapper.ts  # AI SDK → LangChain adapter
│   ├── tools/                 # Agent tools (7 tools)
│   │   ├── bash.ts
│   │   ├── context-retrieval.ts
│   │   ├── edit-file.ts
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

MIT

---

## Repository

[Yahya-hacker/shadow-auditor](https://github.com/Yahya-hacker/shadow-auditor)

---

*Shadow Auditor: Autonomous security for teams that demand evidence.*
