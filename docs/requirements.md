# Requirements coverage and scope record

This matrix records the substantive themes of the supplied 30-section ContextLine brief. It is a normalized traceability view, not a verbatim transcript; the original brief was provided in conversation rather than as a repository file. Corrections and unsupported claims are documented in [research](research.md) and [decisions](decisions.md).

Status legend: **Implemented** = executable code and tests; **Partial** = usable foundation with explicit limits; **Documented** = analysis/runbook without a claimed runtime feature; **Deferred** = roadmap only.

| # | Brief theme | Status | Evidence / limitation |
|---|---|---|---|
| 1 | Problem: permissions lost across AI derivatives | Implemented foundation | Root registry + enforcement + propagation; market ranking remains a hypothesis |
| 2 | Vision: source-aware access layer | Documented | [README](../README.md), [architecture](architecture.md) |
| 3 | Dependency registry with forward/backward lookup | Implemented | `dependencies_by_source/artifact`; batched lookup; version/tenant keys |
| 4 | Real-time authorization via existing auth | Implemented | Strict batched callback, all-root AND, timeout/error policy; no built-in policy engine |
| 5 | Async lifecycle cleanup | Implemented | Transactional outbox, jobs, leases, retries, dead letters, verification |
| 6 | TypeScript SDK | Implemented | `packages/core`, declarations, examples; workspace-local, not npm-published |
| 7 | PostgreSQL registry | Implemented | Seven tables, forced RLS, migrations, real-PG tests |
| 8 | Background worker | Implemented | Programmatic API + env-driven CLI + metrics/health |
| 9 | Configuration-only control plane | Partial | JSON/env/CLI configuration; no hosted/admin UI control plane |
| 10 | Fail-closed defaults | Implemented, conditional | Default deny/required audit; explicit overrides and integration contract documented |
| 11 | Unregistered-artifact policy | Implemented | Deny/quarantine/allow; tombstones always deny; backfill evidence |
| 12 | Multi-source and transitive lineage | Implemented | Flattened root union; intermediate graph visualization deferred |
| 13 | Incremental adoption | Documented + partial tooling | Staged guide, quarantine telemetry; automatic discovery/backfill deferred |
| 14 | Tenant isolation | Implemented | Composite FKs, forced RLS, least-privilege grants, Redis prefix; privileged bypass remains |
| 15 | Version awareness | Implemented | Current-version checks, update events, old-version invalidation |
| 16 | Connector interfaces | Implemented + partial coverage | PostgreSQL/pgvector/Redis shipped; custom interface; other stores deferred |
| 17 | Verification, retries, audit evidence | Implemented | Independent verify, fencing, bounded history, append-only runtime grants |
| 18 | Human review for memory | Implemented | Flagged artifacts blocked; acknowledgement keeps blocked; erasure deletes |
| 19 | Deployment guidance | Documented + artifacts | Dockerfile/Compose/role provisioner; container not locally executed |
| 20 | Security model and failure modes | Documented + tests | Conditional guarantees, threat model, policy matrix |
| 21 | Privacy/erasure/legal analysis | Documented + technical workflow | Metadata privacy, conditional GDPR workflow; no compliance certification |
| 22 | Observability and operations | Partial | Prometheus counters/gauges, health, runbooks; latency histograms/oldest-age deferred |
| 23 | Reproducible revocation demo | Implemented | Interactive UI + CLI + HTTP smoke; synthetic data, no LLM |
| 24 | Automated testing | Implemented + optional live | 35 unit, 28 real-PG, smoke; Redis/pgvector live path not locally run |
| 25 | Performance targets | Measured, target unmet | Local durable-audit p95 ~137ms; `<5ms` remains unachieved target |
| 26 | Market size and adoption-barrier claims | Documented as hypotheses | No verified ranking/TAM; discovery plan and assumption formulas |
| 27 | Competitive landscape | Documented | Prior art and gaps; no invented competitor ARR or absence claims |
| 28 | Pricing and GTM | Documented as hypotheses | Packaging/pricing anchors, design-partner motion, decision gates |
| 29 | Risks, exclusions, roadmap | Documented | Prompt injection, model weights, backups, direct bypass out of scope; gated roadmap |
| 30 | In-depth documentation recorded in repo | Implemented | This docs tree, README, notices, validation, CI/deploy artifacts |

## Explicit exclusions retained from the brief

ContextLine does not replace IAM/SSO, evaluate a new policy language, classify/redact content, provide prompt-injection/output guardrails, perform model unlearning, erase backups automatically, discover every unregistered derivative, or guarantee compliance. It also does not claim to solve already-delivered responses or downstream copies.

## Scope corrections made during implementation

- Principal-specific revocation is audit-only; source-wide restriction/deletion is separate.
- Four domain tables were expanded to seven to support durable jobs and access evidence.
- Transitive lineage is flattened to roots for enforcement rather than storing a full graph.
- “Metadata only” is not treated as a GDPR exemption.
- Connector success requires verification; review acknowledgement is not deletion.
- Latency and market claims are labeled as targets/hypotheses, with actual local measurements recorded.
- Hosted control plane, SSO, billing, and broad connector coverage are deferred rather than implied by the demo.

## Acceptance evidence

The default release gate is `npm run check`. The end-to-end demo must show: authorized cache hit → principal revocation denial without shared deletion → source deletion blocking before cleanup → verified deletion of 18 Acme revenue derivatives → other-tenant isolation. See [validation](validation.md) for observed results and skipped environments.
