# Public-client release integration

The current baseline is a monolithic local CLI. It does **not** yet implement
the public-client/private-service package boundary and must not be published as
though that separation were complete.

The release workflow is intentionally fail-closed. Its build and exact-tarball
smoke jobs run independently, but the publish job runs only when all existing
release protections pass and the repository variable
`NPM_PUBLISH_ENABLED` is exactly `true`. A missing or differently valued
variable keeps publication disabled.

## Required package-boundary integration

The final public-client integration must add a repository-enforced package
boundary before publication is enabled:

- Add `protocol/**` to the public package's `files` allowlist.
- Require the tarball to contain the protocol manifest, schemas, and signing vector,
  including `protocol/manifest.json`, `protocol/schemas/**`, and
  `protocol/signing-vectors.json`.
- Reject tarballs containing proprietary prompts, workflow/orchestration
  implementations, provider implementations, or private-service modules.
- Reject public-client manifests that depend on private execution dependencies,
  including model-provider SDKs, `@ai-sdk/*`, `@langchain/*`, `ai`, and
  `ollama-ai-provider`.
- Install the exact tarball into an offline clean consumer and verify that the
  packaged protocol manifest, schemas, and signing vector can be loaded without
  the repository checkout or network access.

These checks belong in the final client/core split integration. They are not
enabled on this monolithic baseline because doing so would either fail every
release build or falsely claim that the boundary already exists.

## Publication cutover order

Keep `NPM_PUBLISH_ENABLED` absent until the following steps are complete, in
this order:

1. Create the protected GitHub `npm` environment. Require an independent
   reviewer, prevent self-review, and restrict deployments to the approved
   `v*` release-tag policy.
2. Establish npm package ownership if necessary, then configure npm trusted
   publishing for `Yahya-hacker/shadow-auditor`, workflow `release.yml`, and
   environment `npm`. Revoke any short-lived bootstrap token immediately.
3. Integrate and verify the public-client boundary checks above against the
   exact packed and offline-installed artifact.
4. Only then create the repository variable `NPM_PUBLISH_ENABLED` with the
   exact value `true`.

Disabling publication again requires deleting the variable or changing its
value to anything other than `true`.
