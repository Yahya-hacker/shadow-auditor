<div align="center">
  <img src="https://github.com/user-attachments/assets/df96b04f-7324-4a07-9100-ff81526e0d31" alt="Shadow Auditor">
</div>

# Shadow Auditor

**Autonomous AI-powered cybersecurity operations CLI** focused (in this first version) on **SAST**.

Shadow Auditor is built for offensive-minded static security reviews: it maps your codebase, enters an interactive analyst shell, and lets an AI security agent investigate vulnerabilities, read code, search patterns, and propose fixes with human approval.

## Why Shadow Auditor

- Designed for **cybersecurity operations**, not generic chat.
- Uses a **security-specialized system prompt** and structured audit workflow.
- Supports **agentic tooling** (file reads, code search, directory listing, patch proposals, command execution).
- Built with **human-in-the-loop controls** for sensitive actions.
- Starts as a **SAST-first engine** and is evolving rapidly toward a complete multi-agent security platform.

## Current Version Scope (v1)

This release is specialized in **Static Application Security Testing (SAST)**:

- Structural codebase mapping using Tree-sitter
- Interactive security shell (`shadow-auditor`)
- Stateful analysis session with streaming responses
- Tool-assisted vulnerability hunting and remediation proposals
- User-confirmed file edits and command execution

## Roadmap

Shadow Auditor is moving quickly. Upcoming versions will focus on:

1. **Performance**: faster mapping, lower latency, and larger-repo scalability.
2. **UX/UI**: cleaner interaction flow and improved operator ergonomics.
3. **Expanded security domains**:
   - **Active pentesting workflows**
   - **DAST (Dynamic Application Security Testing)**
4. **Full multi-agent orchestration**:
   - Multiple cooperating agents
   - Agents from the same provider or different providers
   - Smooth cross-agent coordination for complex security operations

## Supported AI Providers

Shadow Auditor already supports a broad provider base:

- **Anthropic**
- **OpenAI**
- **Google (Gemini)**
- **Mistral**
- **Ollama** (local models)
- **Custom OpenAI-compatible providers** via custom base URL

This means you can use many additional vendor endpoints through the OpenAI-compatible integration path.

## Installation

### Global install

```bash
npm install -g shadow-auditor
```

### Local development

```bash
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm install
npm run build
```

## Quick Start

Run:

```bash
shadow-auditor
```

What happens:

1. Welcome/boot sequence
2. Config check (or interactive setup wizard)
3. Target directory selection
4. Repo map generation
5. Drop into interactive shell prompt

You can also force setup:

```bash
shadow-auditor --reconfigure
```

### Audit Modes

Control the depth, tool budget, and report style of each audit:

```bash
shadow-auditor --mode triage        # Fast pass — highest-confidence findings only
shadow-auditor --mode deep-sast     # Full SAST analysis with verification chains (default)
shadow-auditor --mode full-report   # deep-sast + enriched remediation + executive summary
shadow-auditor --mode patch-only    # Produce code patches/fixes, minimal narrative
```

Legacy aliases `balanced`, `deep`, and `quick` are still accepted for backward compatibility.

### CI Mode

For automated pipelines:

```bash
shadow-auditor --ci --fail-on high   # Exit 1 if High or Critical findings exist
shadow-auditor --ci --fail-on medium # Exit 1 if Medium, High, or Critical findings exist
shadow-auditor --ci --fail-on none   # Always exit 0 (report-only CI)
```

`--fail-on` accepts: `critical`, `high`, `medium`, `low`, `none`. Default is `high`.

### Incremental / Diff Scan Mode

Scope the analysis to only files changed since a git ref:

```bash
shadow-auditor --diff                    # Changed files since HEAD~1
shadow-auditor --diff --since HEAD~5     # Changed files since 5 commits back
shadow-auditor --diff --since main       # Changed files since branch 'main'
```

## Interactive Shell

Prompt:

```text
Shadow Auditor ❯
```

Example prompts:

- `Analyze authentication flow`
- `Find all injection vulnerabilities`
- `Run a full audit`
- `Review dangerous command execution patterns`

Exit with:

- `exit`
- `quit`
- `Ctrl+C`

## Safe vs Expert Command Surface

By default, command execution is policy-limited to safe families (`git status|diff|log`, `npm test|run lint|run build`, and pnpm/yarn equivalents when enabled), with explicit deny rules for destructive patterns.

Use expert mode only when needed:

```bash
shadow-auditor --expert-unsafe
```

In expert mode, broader command/MCP tool calls are allowed but still require explicit confirmation and show warnings.

## Run Artifacts and CI Outputs

Each session writes persistent artifacts under:

```text
<target>/.shadow-auditor/runs/<ISO-timestamp>-<id>/
```

Generated files:

- `session-meta.json`
- `messages.jsonl`
- `tool-events.jsonl`
- `report.md`
- `report.json` (validated, deduplicated structured findings with stable `vuln_id` values)
- `report.sarif` (generated when findings exist; deterministic and GitHub Code Scanning compatible)

### Stable Vulnerability IDs

Every finding gets a deterministic `vuln_id` of the form `SHADOW-<CWE>-<HEX8>`, derived from:

- Normalized title and CWE
- Primary file path (when available)
- Key evidence line numbers

The same finding in the same repo+commit always produces the same `vuln_id`.

### Finding Deduplication

Multiple occurrences of the same root-cause vulnerability (same CWE + title) are automatically grouped into a single finding with merged `file_paths`. SARIF output stays clean and non-duplicated.

### CVSS Consistency Checks

The internal CVSS scorer validates v3.1 vectors and can flag mismatches between reported scores and computed scores. See `src/core/output/cvss-scorer.ts` for programmatic use.

## Security Workflow Model

Shadow Auditor combines:

- **Repo-level structural intelligence** (compressed architecture map)
- **Deep file inspection on demand**
- **Global pattern hunting**
- **Patch proposal with user confirmation**
- **Command execution with user confirmation**

This keeps the tool autonomous enough to be productive while preserving operator control.

## Configuration

On first run, configuration is saved in:

```text
~/.shadow-auditor.json
```

Stored fields include:

- `provider`
- `model`
- `apiKey` (not required for Ollama)
- `customBaseUrl` (for custom OpenAI-compatible providers)
- optional runtime controls (`maxOutputTokens`, `maxToolSteps`, policy/MCP extensions)

> ⚠️ API keys in `~/.shadow-auditor.json` are plaintext. This remains for backward compatibility; a secure secret-store extension hook exists for future keychain integration.

## Requirements

- Node.js `24.14.1` (LTS)
- npm

## Development

```bash
npm run lint
npm run build
npm test
```

## Disclaimer

Shadow Auditor is a cybersecurity tool. Use only on codebases and systems you are authorized to assess. You are responsible for lawful and ethical usage.

## Vision

Shadow Auditor is a next-generation **application security auditing CLI** built for teams that need high-signal results across real-world codebases—without compromising on safety, reproducibility, or operational fit.

It combines an autonomous, **SAST-first workflow** with strict evidence requirements and policy-controlled tool execution, so every finding is not just plausible—it is **defensible**.

### What makes it different

**Evidence-backed findings, by design**  
Shadow Auditor is built around traceability. Every finding carries concrete code references, a clear reasoning path, and actionable remediation guidance. The goal is to eliminate noise and give security engineers output they can act on immediately—and stand behind in an audit or review.

**Human-in-the-loop safety and policy controls**  
Autonomous analysis is only valuable when it stays within defined boundaries. Shadow Auditor gates risky actions through explicit policies and operator confirmation, making it suitable for professional environments where auditability, least-privilege behavior, and responsible usage are non-negotiable.

**Structured outputs built for CI pipelines**  
Every run produces persistent artifacts under `.shadow-auditor/runs/`: structured findings in `report.json`, a `report.sarif` file for integration with GitHub Advanced Security and other SARIF-compatible platforms, and a full `report.md` for human review. Deterministic finding identifiers and deduplication make results stable and comparable across commits.

**Context management that scales to real repositories**  
Large codebases exceed any single context window. The roadmap targets hybrid retrieval—combining lexical search, semantic embeddings, and a typed knowledge graph of entities, flows, and evidence—so the agent retains relevant context across long sessions and can connect discoveries made early with signals found later.

**A multi-agent architecture built for complex systems**  
The forward direction is a coordinated agent mesh: specialized roles for recon, dataflow analysis, exploit-chain validation, remediation, and independent verification—operating in parallel and synchronizing through shared evidence. Each agent writes to a common blackboard; a verifier role enforces anti-hallucination gates before any finding is promoted to the report. This is not an experimental idea—it is the design target, and current architecture decisions reflect it.

### The goal

Shadow Auditor aims to be the tool security engineers and developers reach for when results genuinely matter: a rigorous, governance-friendly, CI-integrated system that scales from a single repository to a full engineering organization—with reproducible, auditable findings at every step.

> Shadow Auditor is a cybersecurity tool. Use only on codebases and systems you are authorized to assess.
