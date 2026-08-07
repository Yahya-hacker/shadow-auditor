# Security Policy

## Supported versions

Before the first public release, security fixes are applied to `main` on a
best-effort basis. After release, only the latest published version is
supported unless a GitHub security advisory says otherwise.

The npm package is not currently published. Do not treat similarly named
packages from other sources as official releases.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting][private-report] for suspected
vulnerabilities in Shadow Auditor. Do not open a public issue for an
unresolved vulnerability.

Include:

- the affected version, commit, and platform;
- impact and realistic attack prerequisites;
- minimal reproduction steps or a proof of concept;
- suggested mitigations, if known; and
- whether the issue is already public.

Remove credentials, customer data, proprietary target code, and other
third-party secrets from reports. Use synthetic examples whenever possible.

Reports are acknowledged and triaged on a best-effort basis. Please allow time
for validation and a coordinated fix before disclosure. The project does not
offer a bug bounty or guarantee compensation.

## Scope

In scope are vulnerabilities in the Shadow Auditor CLI, its release artifacts,
and repository automation. Vulnerabilities in a dependency should also be
reported to that dependency's maintainer when appropriate. Findings in a
codebase scanned by Shadow Auditor belong to that codebase's owner and must
not be submitted here.

Security research must follow the authorization restrictions in
[LICENSE](LICENSE). A vulnerability report does not grant permission to modify
or redistribute Shadow Auditor.

[private-report]: https://github.com/Yahya-hacker/shadow-auditor/security/advisories/new
