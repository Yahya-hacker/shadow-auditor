# Shadow Auditor public client

Shadow Auditor is a local security-audit client for an authorized private backend. The client owns repository indexing, local tool execution, human approvals, evidence validation, durable run state, reports, SARIF, and CI exit policy. Proprietary planning, model access, and decision policy remain on the backend.

This repository is source code for the client. It is not an npm publication announcement.

## Requirements

- Node.js `>=24.14.1 <25`
- A protocol 1.0-compatible Shadow Auditor backend reachable over HTTPS
- A backend-issued device enrollment code
- An operating-system credential store supported by `cross-keychain`

Only audit repositories and systems you are authorized to test.

## Build from source

```sh
git clone https://github.com/Yahya-hacker/shadow-auditor.git
cd shadow-auditor
npm ci
npm run build
node ./bin/run.js --help
```

Run the built client with:

```sh
node ./bin/run.js
```

On first use, enter the backend HTTPS URL, a device name, and the one-time enrollment code. The client generates an Ed25519 device key, pins the backend signing keys returned during enrollment, stores private device credentials in the operating-system keychain, and writes non-secret configuration to `~/.shadow-auditor/config.json`.

Use `--reconfigure` to enroll a different device or backend:

```sh
node ./bin/run.js --reconfigure
```

## Local and remote boundary

The client sends purpose-built protocol DTOs, never LangGraph state or JavaScript runtime objects. Repository maps, semantic indexes, Tree-sitter analysis, command policy, DAST controls, MCP adapters, remediation, evidence checks, and report safety checks remain local. Backend tool proposals can access the repository only through negotiated local tools and their bounded JSON results.

Every non-read tool proposal requires a local, digest-bound approval. CI denies non-read proposals. Local command and MCP policy can still deny an approved proposal. A backend execution grant must match the approved proposal, input digest, tool schema, risk level, and nonce before execution.

Interactive controls:

| Command | Effect |
| --- | --- |
| `/tools` | Show negotiated local tools and risk levels |
| `/usage` | Show validated usage totals |
| `/status` | Show the current remote session |
| `/pause` | Persist the cursor and pause the session |
| `/resume` | Resume from the durable cursor and event hash |
| `/cancel` | Cancel the current session |
| `exit` | Close local resources and exit |

## Transport and durable state

All API traffic uses HTTPS. Authenticated requests carry Ed25519 signatures, request IDs, timestamps, nonces, and body digests. The SSE stream is bounded and processed sequentially for backpressure. Each event must have a valid signature, contiguous cursor, and valid previous-event hash; missing, reordered, oversized, altered, or untrusted events fail closed.

Run data is stored under:

```text
<repository>/.shadow-auditor/
├── cursors/
├── ledgers/
└── runs/<run-id>/
    ├── events.jsonl
    ├── messages.jsonl
    ├── meta.json
    ├── report.json
    ├── report.md
    └── report.sarif
```

The execution ledger is append-only and hash-chained. Decisions and results are persisted before submission. After interruption, an identical proposal reuses its durable decision, an identical grant reuses its durable result, and an execution with an uncertain outcome is not repeated automatically.

## CI

Enroll the device before the CI run and provide a valid `~/.shadow-auditor/config.json`. Supply device credentials through the runner's operating-system keychain or the read-only `SHADOW_AUDITOR_DEVICE_CREDENTIALS` secret. Never commit the credential JSON.

CI requires an objective, defaults to the current directory, produces the same local reports, and exits non-zero when validated findings meet the configured threshold:

```sh
node ./bin/run.js \
  --ci \
  --objective "Audit authentication changes for privilege escalation" \
  --target . \
  --diff \
  --since origin/main \
  --fail-on high
```

Exit code `0` means no finding met the threshold, `1` means at least one validated finding met it, and `2` means configuration, transport, protocol, execution, or report validation failed.

## Configuration

The interactive setup writes the required backend URL, credential account, device name, audit mode, and local policy settings. Optional settings in `~/.shadow-auditor/config.json` include:

- command allowlists, denylists, and expert mode
- incremental scan baseline
- local Ollama semantic indexing
- DAST host, request, and runtime bounds
- MCP adapter endpoints
- remediation test commands
- CI severity and output policy

The backend URL must use `https://`. Environment-supplied credentials are intentionally read-only and cannot be refreshed or rotated by the client.

## Protocol 1.0

The frozen contract consists of:

- `protocol/openapi.json` — OpenAPI 3.1 API and SSE contract
- `protocol/schemas/` — strict JSON Schemas
- `src/protocol/generated.ts` — generated TypeScript DTOs
- `protocol/signing-vectors.json` — deterministic canonicalization and Ed25519 vectors
- `protocol/manifest.json` — per-file hashes and aggregate contract digest

Canonical contract digest:

```text
sha256:cedb819cfd76f99ef26eaa18cbb1fe80a7729b321ba50a4d3b9df9d7800d9cc5
```

Validate schema generation and drift with:

```sh
npm run check:protocol
```

## Backend requirements

The private backend must implement the frozen OpenAPI 3.1 contract exactly and:

- negotiate protocol `1.0`, required features, bounded payload sizes, local tool descriptors, and enrollment-pinned signing keys
- return new sessions at cursor `0` with `lastEventHash: null`
- emit durable, signed, hash-chained `EventEnvelope` records over `text/event-stream`
- preserve cursor replay semantics across disconnects and process restarts
- bind proposals, decisions, grants, and results to their specified digests and signatures
- treat a retry of the same signed request ID and identical body as idempotent, while rejecting reuse with altered metadata or payload
- return RFC 9457 problem details for structured failures
- support device enrollment and refresh, health/readiness, capability negotiation, session creation, pause/resume/cancel, decisions, results, and usage records

The backend must not expect public clients to send prompts, provider credentials, private workflow state, or serialized `AgentState`.

## Development validation

```sh
npm test
npm run lint
npm run build
npm run check:protocol
npm run check:package
```
