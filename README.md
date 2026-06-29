<div align="center">
  <img src="https://github.com/user-attachments/assets/df96b04f-7324-4a07-9100-ff81526e0d31" alt="Shadow Auditor">
</div>

# 🌑 Shadow Auditor: The Next Generation of Autonomous Security Testing

> *In the realm of application security, silence is dangerous. Shadow Auditor hunts in the silence—mapping vast codebases, finding the vulnerabilities your static tools missed, and delivering evidence-backed findings that prove beyond doubt where the risk lies.*

---

## The Legend

**Shadow Auditor** is an autonomous, AI-powered Static Application Security Testing (SAST) CLI engineered for security teams who demand rigor, reproducibility, and results. It is not a generic chatbot. It is a specialized security operative—one that understands code architecture, knows attack patterns, and hunts vulnerabilities with methodical precision.

### What It Does

Shadow Auditor automates the entire offensive security workflow:

1. **Sees the whole picture** — Maps your entire codebase using Tree-sitter, building a compressed structural intelligence map
2. **Hunts with intent** — Launches an AI security agent into an interactive shell to investigate code flows, search for patterns, and identify attack surfaces
3. **Gathers evidence** — Every finding is traceable, linked to concrete code, backed by reasoning, and validated
4. **Proposes remediation** — Generates patches and fixes with your explicit approval
5. **Fits into your CI** — Produces structured artifacts (JSON reports, SARIF for GitHub Advanced Security, Markdown for humans)
6. **Respects boundaries** — Human-in-the-loop controls and policy gates ensure responsible, auditable execution

---

## Why Shadow Auditor Exists

### The Problem It Solves

- **Generic AI chat tools** don't understand security context or codebases
- **Traditional SAST tools** are noisy, hard to tune, and produce findings you can't act on
- **Manual security reviews** don't scale and require expert knowledge
- **Automation without governance** is risky—you need proof of what was audited and why

### The Solution Shadow Auditor Provides

- **Security-specialized AI** — Built around security analysis, not chat
- **Architectural understanding** — Knows your code structure before diving into details
- **Agentic capability** — Can read files, search patterns, execute commands (with your approval)
- **Structured evidence** — Every finding is deterministic, reproducible, and auditable
- **Governance by design** — Policy controls and human-in-the-loop gates for sensitive actions
- **Built for operations** — Ready for CI pipelines, incremental scans, and team workflows

---

## The Arsenal: Core Capabilities

### 🏗️ Intelligent Codebase Mapping

Shadow Auditor doesn't dive blind. On startup, it:
- **Parses your entire codebase** using Tree-sitter (with support for JavaScript, TypeScript, and expanding language support)
- **Builds a compressed architecture map** showing file structure, dependencies, and code patterns
- **Indexes key entities**: functions, classes, imports, exports—everything the agent needs to understand your system

This map stays in memory during your session, giving the AI instant context about where everything lives.

### 🔍 Interactive Security Shell

Once the map is built, you drop into an **interactive analyst shell**:

```
Shadow Auditor ❯ _
```

Here you can:
- **Issue natural-language security queries** — `"Find all injection vulnerabilities"`, `"Analyze authentication flow"`
- **Trigger tool-assisted investigations** — The agent reads files, searches patterns, cross-references code
- **Get real-time streaming responses** — See the reasoning unfold as the agent hunts
- **Review and approve findings** — Every proposed patch, file edit, or command execution requires explicit approval

### 📊 Evidence-Backed Findings

Every vulnerability Shadow Auditor reports comes with:

- **Concrete code references** — File paths, line numbers, code snippets
- **Clear reasoning** — Why the code is vulnerable, what attack it enables
- **CVSS v3.1 scoring** — Validated severity assessments
- **Stable vulnerability IDs** — Deterministic `SHADOW-<CWE>-<HEX8>` identifiers that never change for the same finding in the same commit
- **Deduplication** — Multiple instances of the same root-cause vulnerability are grouped into a single finding

### 🛠️ Remediation Proposals

For each finding, Shadow Auditor can:

- **Propose code patches** — Concrete fixes you can review before applying
- **Run validation tests** — Verify the patch doesn't break existing functionality
- **Suggest secure patterns** — Recommend better approaches based on the codebase context

You are always in control—patches are never applied without your explicit approval.

### 🚀 Multi-Mode Audit Strategies

Run Shadow Auditor in different modes depending on your needs:

```bash
shadow-auditor --mode triage        # Fast pass — highest-confidence findings only
shadow-auditor --mode deep-sast     # Full SAST analysis (default)
shadow-auditor --mode full-report   # deep-sast + enriched remediation + executive summary
shadow-auditor --mode patch-only    # Produce code patches, minimal narrative
```

### 🔄 Incremental / Diff Scanning

Security in CI doesn't mean auditing the whole codebase every time:

```bash
shadow-auditor --diff                 # Only files changed since HEAD~1
shadow-auditor --diff --since main    # Only files changed since 'main' branch
```

This keeps CI fast while still catching vulnerabilities in newly changed code.

### 📋 CI/CD Integration

Run in automated pipelines with:

```bash
shadow-auditor --ci --fail-on high    # Exit 1 if High or Critical findings exist
shadow-auditor --ci --fail-on none    # Report-only, always exit 0
```

Every run produces:
- **`report.json`** — Structured findings with stable IDs, deduplicated
- **`report.sarif`** — SARIF format for GitHub Code Scanning, GitLab, and other platforms
- **`report.md`** — Human-readable Markdown summary
- **`messages.jsonl`** — Full conversation history with the AI
- **`tool-events.jsonl`** — Log of all tool calls, approvals, and commands

All artifacts are stored in `.shadow-auditor/runs/<timestamp>/` for audit trails and historical analysis.

---

## The Provider Ecosystem

Shadow Auditor is provider-agnostic. Use **any** supported AI provider:

- **Anthropic** — Claude models, security-optimized
- **OpenAI** — GPT-4, GPT-4o, and latest models
- **Google Gemini** — High-performance analysis
- **Mistral** — Fast, cost-effective alternative
- **Ollama** — Run local models (open-source, privacy-first)
- **Custom OpenAI-compatible** — Any endpoint that speaks the API

Choose your provider. Shadow Auditor adapts.

---

## The Workflow: From Code to Confidence

### 1. **Boot & Configure**

```bash
shadow-auditor
```

On first run:
- Welcome sequence
- Config wizard (API key, model selection, preferences)
- Config saved to `~/.shadow-auditor.json` for future runs

### 2. **Map the Territory**

Select your target directory, and Shadow Auditor:
- Parses the codebase
- Builds the architecture map
- Compresses it for the AI context window
- Stores metadata for incremental queries

### 3. **Enter the Shell**

Interactive mode: issue queries, review findings, approve patches.

```bash
Shadow Auditor ❯ Analyze authentication flow
```

The agent investigates, gathering evidence in real-time. You see the reasoning unfold.

### 4. **Review & Decide**

For each proposed finding, patch, or command:
- Review the evidence
- Approve, reject, or refine
- Commands are executed only with your consent

### 5. **Collect Artifacts**

When done, artifacts are written to `.shadow-auditor/runs/`:
- Structured findings (JSON, SARIF)
- Full conversation history
- Tool execution logs

These artifacts are:
- **Persistent** — Never auto-deleted, full audit trail
- **Reproducible** — Same codebase + commit = same findings
- **Verifiable** — Every step is traceable

---

## Safety & Governance: The Human-in-the-Loop Model

Shadow Auditor is autonomous, but never reckless.

### Command Execution Policy

By default, command execution is **policy-limited** to safe families:
- `git status`, `git diff`, `git log`
- `npm test`, `npm run lint`, `npm run build`
- (and pnpm/yarn equivalents)

Destructive patterns are explicitly denied:
- No `rm -rf`, no `mv`, no `git reset --hard`
- No installing packages without approval
- No arbitrary shell execution

For advanced users, **expert mode** enables broader capabilities:

```bash
shadow-auditor --expert-unsafe
```

Even in expert mode, sensitive actions are flagged and require confirmation.

### Explicit Approval Gates

- **File edits** — Proposed patches are shown before application
- **Command execution** — Each command requires confirmation
- **Finding generation** — High-risk findings go through additional validation

This ensures Shadow Auditor stays within your security policy.

---

## The Roadmap: From SAST to Full Security Operations

### Version 1 (Current): SAST Foundation ✅

- Structural codebase mapping
- Interactive security shell
- Stateful analysis sessions
- Tool-assisted vulnerability hunting
- Evidence-backed findings with stable IDs
- SARIF output for CI integration

### Version 2+: The Multi-Agent Security Mesh

The vision extends far beyond SAST:

1. **Performance & Scale**
   - Faster codebase mapping
   - Larger repository support
   - Lower latency responses

2. **Enhanced UX**
   - Improved interaction flow
   - Better operator ergonomics
   - Visual findings summary

3. **Expanded Security Domains**
   - Active pentesting workflows
   - DAST (Dynamic Application Security Testing)
   - Supply chain analysis

4. **Full Multi-Agent Orchestration**
   - Specialized roles: recon, dataflow analysis, exploit-chain validation, remediation, verification
   - Parallel agent execution with synchronized evidence
   - Shared blackboard for findings and reasoning
   - Anti-hallucination verification gates
   - Independent verification before findings are promoted to reports

The roadmap reflects a core truth: **complex security operations require coordinated specialists, not a single generalist**.

---

## Getting Started

### Installation

#### Global Install
```bash
npm install -g shadow-auditor
```

#### Local Development
```bash
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm install
npm run build
```

### Requirements
- **Node.js 24.14.1+** (LTS)
- **npm**

### Quick Start

```bash
shadow-auditor
```

This starts the interactive shell. No arguments needed for first run.

### Advanced Options

```bash
shadow-auditor --reconfigure      # Reconfigure API key or model
shadow-auditor --mode triage      # Fast security pass
shadow-auditor --mode deep-sast   # Full analysis (default)
shadow-auditor --ci --fail-on high  # CI mode
shadow-auditor --diff --since main  # Incremental scan
shadow-auditor --expert-unsafe     # Expert mode with broader capabilities
```

---

## Inside the Shell: Example Queries

Once you're in the interactive shell, try:

```
Shadow Auditor ❯ Find all SQL injection vulnerabilities
Shadow Auditor ❯ Analyze the authentication middleware
Shadow Auditor ❯ Search for hardcoded secrets
Shadow Auditor ❯ Review file validation logic
Shadow Auditor ❯ Run a full audit
```

Exit with: `exit`, `quit`, or `Ctrl+C`

---

## The Architecture: Designed for Evidence

### Session Artifacts

Every run produces a persistent artifact folder:
```
<target>/.shadow-auditor/runs/<ISO-timestamp>-<id>/
```

Inside:
- **`session-meta.json`** — Run metadata, mode, config, timing
- **`messages.jsonl`** — Complete conversation history
- **`tool-events.jsonl`** — Log of all tool invocations
- **`report.json`** — Structured findings (deduplicated, stable IDs)
- **`report.sarif`** — SARIF format for CI integration
- **`report.md`** — Human-readable Markdown report

### Stable Vulnerability IDs

Every finding gets a deterministic ID: `SHADOW-<CWE>-<HEX8>`

Derived from:
- Normalized title and CWE
- Primary file path
- Key evidence line numbers

**Same codebase + same commit = same finding ID.** This makes results reproducible and comparable.

### Deduplication & CVSS Consistency

- Multiple instances of the same root-cause vulnerability are grouped into one finding
- CVSS v3.1 vectors are validated
- Inconsistencies between reported and computed scores are flagged

---

## Development

```bash
npm run lint      # Lint the codebase
npm run build     # Compile TypeScript
npm test          # Run full test suite
```

---

## The Vision: Rigorous, Defensible Security

### What Makes Shadow Auditor Different

**Evidence-backed findings, by design**

Every vulnerability comes with concrete code references, reasoning paths, and actionable remediation. Security engineers get output they can act on immediately—and stand behind in audits.

**Human-in-the-loop safety**

Autonomous analysis only works when bounded by policy. Shadow Auditor gates risky actions through explicit policies and operator confirmation, suitable for professional environments where auditability is non-negotiable.

**Structured outputs for CI pipelines**

Persistent artifacts under `.shadow-auditor/runs/`, deterministic finding IDs, and SARIF output mean results are:
- Reproducible across runs
- Comparable across commits
- Integrable with GitHub, GitLab, and other platforms

**Context management that scales**

Large codebases exceed any single context window. The roadmap targets hybrid retrieval—combining lexical search, semantic embeddings, and a knowledge graph of entities and flows—so the agent retains relevant context across long sessions.

**A multi-agent mesh for complex operations**

The future is specialized roles operating in parallel: recon, dataflow analysis, exploit-chain validation, remediation, and independent verification. Each writes to a shared evidence blackboard. A verifier enforces anti-hallucination gates before any finding reaches the report.

---

## The Goal

Shadow Auditor aims to be the tool security engineers and developers reach for when results genuinely matter:

✅ **Rigorous** — Evidence-backed, reproducible, auditable  
✅ **Governance-friendly** — Policy controls and human approval gates  
✅ **CI-integrated** — Structured outputs, stable IDs, SARIF support  
✅ **Scaled** — From single repos to full engineering organizations  

---

## Configuration

On first run, configuration is saved to:
```
~/.shadow-auditor.json
```

Includes:
- `provider` — Which AI provider to use
- `model` — Model name (e.g., `gpt-4`, `claude-3-sonnet`)
- `apiKey` — Your API key (not required for Ollama)
- `customBaseUrl` — For custom OpenAI-compatible endpoints
- `maxOutputTokens` — Output token limit (optional)
- `maxToolSteps` — Max tool calls per query (optional)

⚠️ **Note:** API keys are stored in plaintext for backward compatibility. A secure secret-store extension hook is planned for future releases.

---

## Disclaimer

**Shadow Auditor is a cybersecurity tool.** Use only on codebases and systems you are authorized to assess. You are responsible for lawful and ethical usage.

---

## License

MIT

---

## Join the Mission

Shadow Auditor is being built for teams that take security seriously. If you want to:
- **Use it** — Install and start hunting vulnerabilities
- **Contribute** — Help build the multi-agent mesh
- **Report issues** — Found a bug? Open an issue on GitHub
- **Share feedback** — Your workflow insights shape the roadmap

**Repository:** [Yahya-hacker/shadow-auditor](https://github.com/Yahya-hacker/shadow-auditor)  
**Issues & Feedback:** [GitHub Issues](https://github.com/Yahya-hacker/shadow-auditor/issues)

---

*Shadow Auditor: Autonomous security for teams that demand evidence.*
