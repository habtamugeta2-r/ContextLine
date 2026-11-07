# Security policy

## Supported version

This repository is a v0.1.0 reference implementation. Security fixes target the active development branch; there is no hosted service or long-term support commitment yet.

## Reporting a vulnerability

Use the repository's private vulnerability reporting / GitHub Security Advisories feature if it is enabled. If it is not available, contact the maintainers through GitHub and request a private channel before sharing exploit details. Do not publish credentials, personal data, customer content, or a working exploit in a public issue.

Include:

- Affected component/version/commit.
- Deployment assumptions and integration contract.
- Minimal synthetic reproduction.
- Expected versus observed security behavior.
- Impact, prerequisites, and any known mitigations.

Maintainers should acknowledge receipt, triage severity, prepare a regression test and fix, and coordinate disclosure. No response-time SLA is promised by this reference project.

## Scope

In scope: bypasses of documented SDK enforcement, tenant-isolation failures, RLS/grant mistakes, connector verification bugs, lease/fencing errors, audit integrity issues under the runtime role, injection through registry/connector inputs, and demo vulnerabilities that could matter if someone mistakenly deploys it.

Out of scope or conditional: uninstrumented serving paths, incorrect authoritative auth callbacks, compromised privileged database operators, explicit fail-open overrides, missing provenance supplied by a malicious producer, backups/model weights/downstream copies, and prompt-injection/output guardrail issues. These are documented boundaries, not reasons to ignore a concrete bypass of the stated contract.

The demo has no authentication and uses synthetic data. Reports should distinguish demo-only behavior from core SDK/worker behavior.
