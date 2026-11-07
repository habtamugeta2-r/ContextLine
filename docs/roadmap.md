# Roadmap and decision gates

This roadmap is evidence-gated. Items are not commitments or claims of current implementation.

## Phase 0 — Qualification of the current reference build

**Goal:** prove the shipped core loop in environments beyond the sandbox.

- [x] Run GitHub Actions end-to-end after push, including live Redis/pgvector and Docker build.
- [ ] Run the full stack on a Docker/host environment with real connector tables.
- [ ] Integrate one authoritative customer auth callback and measure revocation-to-denial behavior.
- [ ] Load test with realistic network, pool contention, auth latency, audit volume, and tenant skew.
- [ ] Add latency histograms, oldest-event-age, audit-failure, and auth-callback metrics.
- [ ] Test backup restore with lifecycle tombstone replay before serving.
- [ ] Add cross-platform demo bootstrap or documented external-PostgreSQL demo mode.

**Exit criteria:** reproducible live-service qualification, measured end-to-end budget, and an operational owner for dead letters/review.

## Phase 1 — Adoption and coverage tooling

- [ ] Coverage manifest: serving paths × connectors × registered artifacts.
- [ ] Safe backfill tooling with dry-run, conflict reports, and historical-import review.
- [ ] Orphan detection/reconciliation for registration/publication gaps.
- [ ] Producer instrumentation examples for common ingestion frameworks.
- [ ] Tenant onboarding automation and dynamic worker configuration.
- [ ] Policy override inventory and expiry/review workflow.

**Exit criteria:** a design partner can instrument and backfill a bounded corpus without bespoke scripts, and unknown-provenance rate trends to an agreed threshold.

## Phase 2 — Connector breadth and consistency

- [ ] Pinecone/Qdrant/Weaviate/Milvus/Chroma adapters selected by partner demand.
- [ ] Object-store/search-index/document-DB adapters where lifecycle semantics are clear.
- [ ] Connector capability metadata: delete vs invalidate, verification consistency, tenant boundary, retention.
- [ ] Replica/backup-aware verification and restore-time replay hooks.
- [ ] Per-artifact review actions beyond keep-blocked, with explicit safety review.

**Exit criteria:** each adapter has live false-success, cross-tenant, timeout-after-side-effect, and consistency tests—not just a happy-path SDK wrapper.

## Phase 3 — Performance and availability

- [ ] Profile and optimize durable audit path; evaluate safe batching/group commit trade-offs.
- [ ] Optional bounded auth cache with explicit staleness budget and invalidation.
- [ ] Circuit-breaker behavior that preserves fail-closed defaults.
- [ ] Registry HA/failover drills and connection-budget guidance.
- [ ] Tenant fairness/quotas and mass-revocation backpressure.
- [ ] Partitioning/retention strategy based on measured growth.

**Exit criteria:** measured SLOs agreed with partners; no silent fail-open fallback. The draft `<5ms` target remains unclaimed until achieved under a defined workload.

## Phase 4 — Commercial/control-plane capabilities

- [ ] Hosted or self-hosted administrative control plane only after repeated partner demand.
- [ ] SSO/RBAC for operators, configuration versioning, and change audit.
- [ ] Coverage/evidence reports and security-questionnaire exports.
- [ ] Support/connector packaging and pricing validated by paid pilots.
- [ ] Billing/license enforcement only if the chosen model requires it.

**Exit criteria:** at least one paid pilot or explicit budget-owner commitment; operational burden is the product's value, not an undifferentiated dashboard.

## Explicitly out of scope unless separately justified

Prompt-injection/output guardrails, content classification/redaction, model-weight unlearning, training-data governance, universal backup erasure, and replacement IAM/policy engines. These may integrate with ContextLine but are not implied by the current architecture.

## Research backlog

- Verify enterprise adoption-barrier rankings and willingness to pay through primary research.
- Compare actual governance/DSPM product capabilities rather than assuming gaps.
- Obtain legal review for identifier retention, erasure exceptions, and customer-specific jurisdictions.
- Measure real connector consistency and deletion verification under failure.
- Record disconfirming evidence where existing tools adequately solve the workflow.
