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
- `report.json` (validated structured findings)
- `report.sarif` (generated when findings exist)

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

Shadow Auditor is not just a CLI scanner—it is the foundation of a **complete multi-agent cybersecurity operating system**.

Version 1 starts with SAST. The next iterations expand into performance, UX/UI, active pentest operations, DAST, and coordinated multi-agent execution across multiple AI providers.
