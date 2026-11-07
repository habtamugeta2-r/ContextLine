# Blueprint conformance matrix

Status of the implementation against **blueprint A (Revised)**, the authoritative pass.
Conflict resolutions are in [blueprint-conflicts](blueprint-conflicts.md); the blueprint
itself is in [blueprint/blueprint-revised.md](blueprint/blueprint-revised.md).

Legend: **Met** = implemented and covered by a test or gate · **Partial** = implemented
with a stated limit · **Deviation** = deliberately different, rationale recorded ·
**Deferred** = agreed out of scope for this pass.

Measured evidence: [validation](validation.md) · [benchmark-1m.json](benchmark-1m.json).

---

## Part 0 A — defects in the source design

| # | Requirement | Status | Where / evidence |
|---|---|---|---|
| A1 | One batched backward lookup per request | **Met** | `PostgresRegistry.lookupArtifacts` calls `lookup_artifacts($1,$2[],$3[])`; chaos + PG tests; benchmark records `roundTrips: 1` |
| A2 | Tenant set inside the same statement; explicit tenant filters too | **Met** | Migration 002 `SECURITY INVOKER` function sets the GUC then scans; test *"the hot lookup is one round-trip and never leaks tenant context on a reused connection"* asserts the GUC is empty afterwards on a `max:1` pool |
| A3 | ≤3 bulk upserts per registration transaction | **Met** | Set-based `unnest` inserts; test *"bulk registration writes at most three statements for 500 artifacts"* counts statements and asserts each is `unnest`-based |
| A4 | Lease-based locking; expired work is reclaimable | **Met** | Job leases + `heartbeatJob`; chaos 2 kills a worker mid-job and a second worker finishes exactly once |
| A5 | Retries skip completed work | **Met** | Per-artifact `lifecycle_jobs` rows with terminal states; chaos 1 shows attempt 2 only redoing the failed artifact |
| A6 | Operator-owned target allowlist; unknown target is non-retryable | **Met** | `PostgresTableConnector` validates identifiers at construction; `NON_RETRYABLE_CODES` → immediate dead letter; test *"non-retryable connector faults dead-letter on the first attempt"* |
| A7 | Quarantine buffered, flushed every 5s / 100 items | **Met** | `ContextLine` ring buffer + `flushQuarantine` + `close()`; `quarantine_manifest` table; unit + PG tests |
| A8 | Tenant-scoped keys and foreign keys | **Met** | Migration 001; cross-tenant FK test expects `23503` |
| A9 | Enforcement is a sequential pipeline with no shared mutable state | **Met** | `filterAuthorized` builds local maps per call; 47 unit tests cover the policy matrix |

## Part 0 B — product decisions

| # | Requirement | Status | Where / evidence |
|---|---|---|---|
| B1 | Principal-scoped vs source-wide events | **Met** | `lifecycle_events.scope`, `artifacts.owner_principal`, `lifecycleActionFor`; test *"principal revocation touches only that principal cache and memory, never shared derivatives"* |
| B2 | Register first, then write | **Partial** | Enforced in the SDK path and example 01. A storage write published *after* a deletion snapshot can still orphan a physical row; the publication fence stays in the [threat model](threat-model.md) |
| B3 | Revocation race checked inside the registration transaction | **Met** | Source rows locked `FOR SHARE`; new artifacts against non-active/non-current roots raise `SOURCE_UNAVAILABLE`; test *"createSources never reactivates a revoked source"* |
| B4 | Registry holds no personal data | **Deviation (legal)** | Opaque identifiers are required guidance, not a legal conclusion. Docs keep the privacy-qualified position; see conflict 22 |
| B5 | Auth cache off by default, ≤30s, allow-only, local purge | **Met** | `AllowCache`; unit tests incl. *"a cached allow never overrides registry lifecycle state"*; cross-instance purge deferred to v1.1 as the blueprint states |
| B6 | Do not rebuild mappings from auth results | **Met** | Backup/PITR + quarantine backfill CLI; no reconstruction path exists |
| B7 | Fail-closed everywhere; fail-open always audited | **Met** | Deny on auth error/unregistered/registry outage, 500ms default timeout, required audit; chaos 3 and 4 |
| B8 | Scope guard: TS SDK, PG registry, Node worker, 3 connectors | **Met** | Exactly those packages; control plane not built |

## Part 1 — workspace foundation

| Requirement | Status | Notes |
|---|---|---|
| Monorepo with clear package boundaries | **Met** | npm workspaces; `core` (types + SDK + registry) and `worker` |
| pnpm + Turborepo | **Deviation** | npm workspaces + `tsc -b` project references; conflict table §2 |
| `shared-types` / `sdk` / `worker` split | **Deviation** | Types are `core/types.ts` + `core/validation.ts` + `core/policy.ts`; the gate proves the SDK never imports worker code |
| Strict TypeScript, shared lint/format | **Partial** | Strict compiler incl. `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; `.editorconfig` instead of a linter |
| Local containers with health checks | **Met** | Compose with health checks **and** a zero-Docker embedded cluster |
| Separate registry and customer databases | **Partial** | Connectors take their own pool (separate DB is a connection-string change); the demo uses one cluster with separate tables |
| One-command bootstrap | **Met** | `npm run demo` / `npm run demo:cli` |
| CI with real service containers | **Met** | pgvector 17 + Redis 7 services; live connector tests run in CI |
| Gate: SDK runtime deps exactly `pg` | **Met** | `npm run gates` |
| Gate: gzipped bundle <50KB | **Met** | 17.5KB gzipped shipped output (no minification — a conservative upper bound) |
| Gate: no storage access outside allowed locations | **Met** | Static scan: SQL only in `postgres.ts` and `connectors.ts`; registry names only registry tables |
| Decision records folder | **Met** | [decisions](decisions.md) + [blueprint-conflicts](blueprint-conflicts.md) |

## Part 2 — dependency registry

| Requirement | Status | Notes |
|---|---|---|
| Five tables | **Met (8 total)** | The five blueprint tables plus `lifecycle_jobs` (per-artifact state), `access_runs`, `access_decisions` (audit) |
| Closed status/type lists | **Met** | `CHECK` constraints on every enum column |
| Composite tenant-scoped FKs | **Met** | Cross-tenant edge test expects `23503` |
| Covering backward index | **Met** | `dependencies_backward_covering … INCLUDE (source_id, source_version)`; redundant index dropped; asserted by test |
| Forward-lookup index | **Met** | `dependencies_by_source` (already covering) |
| Partial worker-polling index | **Met** | `jobs_claim`, `events_claim` |
| Tenant-and-time audit indexes | **Met** | `decisions_run`, `decisions_artifact`, `decisions_review`, `events_tenant` |
| Admin + app roles, forced RLS, fail-closed | **Met** | `grantRuntimeRole` rejects superuser/BYPASSRLS/owner roles; RLS test now covers 8 tables |
| Idempotent migration runner with advisory lock + history | **Met** | Checksummed `schema_migrations`; concurrent-safe |
| Synthetic data generator | **Met** | `scripts/benchmark.ts` seeds 50 tenants × N artifacts |
| Query-plan review at 100K and 1M rows | **Met** | 1M-row run: lookup p95 **1.16ms** |
| Backward lookup of 10 artifacts <1.5ms at 1M rows | **Met (p95)** | p95 1.16ms, p50 0.81ms; max 17.87ms on shared 2-vCPU hardware — the tail is not bounded |

## Part 3 — core SDK

| Requirement | Status | Notes |
|---|---|---|
| Client validates settings, rejects missing tenant | **Met** | `ContextLineError` codes; unit tests |
| Lazy pool, 10 connections, 200ms acquire | **Partial** | The caller owns the pool; examples and deployment docs specify `max:10, connectionTimeoutMillis:200`. The SDK does not create it, so it cannot enforce it |
| `beginRun` | **Met** | Persisted run identity, validated on every write |
| `registerDerivation` bulk + idempotent + register-first + race check | **Met** | ≤3 bulk writes; 500-artifact cap |
| `filterAuthorized` six steps | **Met** | Batched lookup → split → unregistered policy → dedupe/cache → authorize → conjunctive keep, order preserved, `sourceRefs` attached |
| One auth call per unique source, in parallel, each timed | **Deviation** | Default is one batched call (fewer round-trips, same semantics); `authorizeMode:'per-source'` implements the literal form and is tested |
| `assertCanServe` shares the same core | **Met** | Delegates to `filterAuthorized` |
| `recordSourceEvent` = event + status + cache purge in one transaction | **Partial** | Event + status are one transaction; the local cache purge happens immediately after commit (an in-process map cannot participate in a SQL transaction) |
| `close()` flushes buffers | **Met** | Flushes quarantine and clears the cache; the caller closes the pool |
| Error hierarchy with stable codes | **Met** | Single `ContextLineError` with a stable `code` string, not a class per failure — deliberate, documented |
| Warning records for fail-open | **Met** | `*_allow_override` reasons in the audit trail |
| Unit tests for every policy combination | **Met** | 47 unit tests |
| <5ms filtering 10 candidates / 4 sources | **Met** | p95 **3.18ms** at 1M rows including the durable audit write |

## Part 4 — connectors

| Requirement | Status | Notes |
|---|---|---|
| `connector:target:record` + shared parser | **Met** | `parseStorageRef`; legacy `target/record`, bare-ID and Redis-key aliases still accepted |
| delete / invalidate / verify / healthCheck | **Met** | All three connectors |
| Idempotent delete and invalidate | **Met** | Missing rows verify true; live tests repeat deletes |
| Verify reads the store, never trusts the write | **Met** | Chaos 1 |
| Operator-owned allowlist validated at startup | **Met** | Invalid identifiers throw before any query |
| pgvector: parameterized delete, invalidate falls back to delete | **Met** | Unit test asserts the fallback issues `DELETE` |
| Redis: delete only, no soft invalidation | **Met** | Default `invalidationMode:'delete'`; TTL-preserving tombstone is an explicit opt-in deviation |
| Generic Postgres: stale, or pending review for memory | **Met** | `artifactType` flows through `ConnectorContext` |
| Reusable conformance tests | **Partial** | Shared assertions exist across unit + live suites, but not yet packaged as an exported conformance kit third parties can run |
| Authoring guide with a worked example | **Met** | [connectors](connectors.md) |

## Part 5 — lifecycle worker

| Requirement | Status | Notes |
|---|---|---|
| 1s tick, claim ≤5, `SKIP LOCKED` | **Met** | `intervalMs:1000`, `eventsPerPass:5`; jobs claimed with `FOR UPDATE OF j SKIP LOCKED` |
| Priority: GDPR/revocation → deletion/retention → updates | **Met** | `ORDER BY CASE …`; priority test |
| 60s lease, 20s heartbeat, expired-lease reclaim | **Met** | `leaseMs:60000`, heartbeat defaults to lease/3 (20s at the default lease); chaos 2 |
| Action matrix in one place | **Met** | `packages/core/src/policy.ts`; unit test asserts every cell |
| Mandatory verify after every action | **Met** | `VERIFICATION_FAILED` otherwise |
| Per-artifact state inside the loop | **Met** | `lifecycle_jobs.history`, `verified_at` |
| Backoff 1s/5s/30s/5m/30m ±10% jitter, ceiling 5 | **Met** | `retryDelayMs`; `maxAttempts` default 6 (initial attempt + 5 retries) |
| Non-retryable → straight to dead letter | **Met** | `NON_RETRYABLE_CODES` |
| Dead-letter alert metric | **Met** | `contextline_dead_letter_jobs`, `contextline_job_failures_total` |
| Principal-scoped handling path | **Met** | Only that principal's active cache/memory |
| Connector health feeds metrics | **Met** | `contextline_connector_healthy` |
| Metrics + liveness on 9090 | **Met** | `/metrics`, `/health`; worker CLI qualified locally |
| Graceful drain ≤30s | **Met** | `drainTimeoutMs:30000`, diagnostic on timeout |
| Kill mid-event → another worker finishes in ~70s | **Met** | Chaos 2 with a 1s lease; production default lease is 60s |

## Part 6 — testing, chaos, benchmarking

| Requirement | Status | Notes |
|---|---|---|
| Unit layer | **Met** | 47 tests |
| Integration on real containers | **Met** | 41 PostgreSQL tests (36 integration + 5 chaos) |
| Tenant isolation with a deliberate fault | **Met** | Cross-tenant write `42501`, cross-tenant FK `23503`, pooled-connection GUC test |
| Four workers / 200 events, zero duplicate actions | **Partial** | Concurrency is covered by a two-worker test and the stale-token chaos test; a 4-worker × 200-event soak is not yet scripted |
| Five chaos scenarios | **Met** | `tests/chaos.test.ts` |
| 1M rows / 50 tenants benchmark | **Met** | [benchmark-1m.json](benchmark-1m.json) |
| 10,000 measured calls | **Met** | 10,000 per phase locally |
| Lookup p95 <2ms | **Met** | 1.16ms |
| End-to-end p95 <5ms | **Met** | 3.18ms |
| Warm-cache p95 <2.5ms | **Not met** | 3.50ms. With a zero-latency synthetic callback the cache removes nothing, while the durable audit write remains. The gate is only meaningful against a real network auth service |
| Failed gate fails the build | **Partial** | `.github/workflows/benchmark.yml` runs nightly/manual and fails on the lookup/filter gates; the warm-cache gate is reported, not enforced, for the reason above |

## Part 7 — demo, rollout, control plane

| Requirement | Status | Notes |
|---|---|---|
| Monday-Morning demo with revoke-before-worker proof | **Met** | `npm run demo` (interactive) and `npm run demo:cli`; 18 derivatives, enforcement blocks before cleanup |
| Backfill and quarantine CLI | **Met** | `contextline-migrate quarantine list/resolve/backfill` |
| Security-review kit | **Partial** | [security](security.md), [threat-model](threat-model.md), [architecture](architecture.md), [schema](schema.md) cover the five sample questions; no single packaged questionnaire template yet |
| Five adoption-stage examples | **Met** | [../examples](../examples/README.md), type-checked in CI |
| Operations guide | **Met** | [operations](operations.md), [deployment](deployment.md) |
| Control plane spike | **Deferred** | Explicitly after everything else |
| New developer completes the demo in <5 minutes | **Partial** | One command, no Docker; not yet timed with a first-time user |

---

## Summary

- Of **96** tracked requirements: **Met 80** · **Partial 10** · **Deviation 4** · **Deferred 1** · **Not met 1** (the warm-cache gate, with a stated reason).
- The two headline latency gates that were previously missed by ~27× are now met at the blueprint's full 1M-row scale.
- Every deviation is a recorded decision, not an omission: see [blueprint-conflicts](blueprint-conflicts.md).
