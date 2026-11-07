# Blueprint conflict resolution

The owner supplied three blueprint passes (A Revised, B, C). They disagree in ways that change security outcomes, so each disagreement is resolved explicitly here instead of being silently averaged. Precedence: **A → B → C**, except where a version contradicts a security invariant already proven by tests, or states an unverified absolute.

Status column: **implemented** = in the code today; **this pass** = changed by the conformance work recorded in [conformance](conformance.md); **deviation** = deliberately not adopted, with rationale.

## 1. Correctness and security conflicts

| # | Topic | A (Revised) | B | C | Resolution | Status |
|---|---|---|---|---|---|---|
| 1 | Backward lookup | One batched query per request | One batched query | Task 2.4 step 1: "For each candidate… in parallel using `Promise.all`" | **A.** C contradicts its own latency budget and reintroduces N+1. One batched lookup. | implemented |
| 2 | Tenant context on reads | Set in the same statement or transaction; also filter explicitly | Single round-trip via `set_config` in a CTE | `SET LOCAL` inside a transaction (3 round-trips) | **A+B.** Reads now use one statement with a materialized `set_config` CTE and explicit tenant predicates; writes keep transaction-local `SET LOCAL`. | this pass |
| 3 | Registration writes | ≤3 bulk upserts per transaction | Array `unnest` | Row-by-row cross-product loop | **A+B.** Set-based bulk insert for artifacts and dependencies; optional bulk source upsert. | this pass |
| 4 | Re-registering an existing artifact | Idempotent | — | Task 2.3: `ON CONFLICT DO UPDATE SET status='active'` | **Reject C.** That resurrects deleted/tombstoned artifacts and silently re-enables revoked content. Exact retries are no-ops; changed content requires a new version. | deviation (safety) |
| 5 | Source creation during registration | Bulk upsert sources; check status in the same transaction | Upsert sources | Auto-create sources | **A.** Sources must be active/current for new artifacts. Optional `createSources` performs a bulk insert of *new* version-1 sources only and can never reactivate a revoked/deleted source. | this pass |
| 6 | Principal-scoped revocation | Enforcement + invalidate only that principal's cache/memory | Not distinguished | Deletes all derivatives | **A.** Event carries `scope`; principal-scoped events create jobs only for cache/memory owned by the affected principals. Shared embeddings are never touched. | this pass |
| 7 | Source-wide action matrix | Updated → cache delete, others stale. Revoked-for-all/retention → delete embedding/cache/summary, memory pending review | Same | Simpler: revoke → delete everything | **A.** Matrix implemented as one exported table. | this pass |
| 8 | Redis invalidation | "There is no soft invalidation, only deletion" | `EXPIRE 0`/delete | Task 3.8: `EXPIRE 60`, verify TTL < 60s | **A.** Default invalidate = delete. C leaves readable stale content for up to 60s and cannot prove absence. The existing TTL-preserving tombstone remains available as an explicit opt-in for customers who want a poison value. | this pass |
| 9 | pgvector invalidation without a status column | Fall back to delete | Fall back to delete | Requires status column | **A+B.** Falls back to delete and verifies deletion. | this pass |
| 10 | Generic Postgres memory invalidation | `pending_review` for memory, `stale` otherwise | Same | Always `stale` | **A+B.** Connector receives artifact type and writes `pending_review` for memory. | this pass |
| 11 | Storage reference shape | `connector:target:record` | Same | Same | **A.** Shared parser accepts the canonical colon form; existing `target/record`, bare-ID and Redis-key forms remain accepted as documented legacy aliases. | this pass |
| 12 | Unknown storage target | Non-retryable → dead letter immediately | Same | Retries then DLQ | **A+B.** Configuration/allowlist/reference errors are non-retryable and dead-letter on the first attempt. | this pass |
| 13 | Retry backoff | 1s/5s/30s/5m/30m **with ~10% jitter** | Same | No jitter | **A+B.** Jitter added; deterministic schedule still available for tests. | this pass |
| 14 | Lease and heartbeat | Event lease 60s, heartbeat every 20s, reclaim expired | Same | No lease (zombie trap acknowledged) | **A+B intent, stronger mechanism.** Leases live on per-artifact jobs (the unit that actually calls storage) and are now **heartbeated** while work is in flight, so a long job is not reclaimed mid-operation and a killed worker is still reclaimed within the lease. | this pass |
| 15 | Retry skips completed work | Forward lookup returns only `active` artifacts | Same | Same | **Equivalent-or-stronger.** Per-artifact job rows record completion and verification; retries claim only unfinished jobs. This also survives a worker crash between the storage call and the status write. | implemented |
| 16 | Event idempotency | Idempotency keys implied by outbox | — | Task 2.6: "events are not deduplicated" | **Reject C.** Optional tenant-scoped idempotency key with payload-conflict detection; without a key each call is a distinct audit event. | implemented |
| 17 | Primary keys | Tenant-scoped everywhere | Same | Task 1.1 sources key `(source_id, version)` only | **A.** C would collide across tenants. All keys and FKs include tenant. | implemented |
| 18 | Runtime database role | Admin + app roles, forced RLS, fail-closed | Same | Task 1.6: "superuser role… bypasses RLS" for admin queries | **A.** Migration/owner role is separate; the runtime role must be non-owner, `NOSUPERUSER`, `NOBYPASSRLS`, and provisioning rejects otherwise. | implemented |
| 19 | Quarantine writes | Buffered, flushed every 5s or 100 items | Ring buffer | Synchronous manifest write | **A+B.** Dedicated `quarantine_manifest` table plus an in-memory buffer with background flush and flush-on-close. The required access-decision audit row is still written in the request's single audit batch — that is the audit contract, not the quarantine manifest. | this pass |
| 20 | Auth cache | Off by default, TTL ≤30s, allow-only, local purge on event | TTL cache | TTL cache, no allow-only rule | **A.** Implemented exactly: opt-in, hard 30s cap, only `true` results cached, purged for the source on `recordSourceEvent`. Registry lifecycle state is always read fresh, so a cached allow can never override a revoked/deleted/outdated source. | this pass |
| 21 | Authorization callback shape | One call **per unique source**, in parallel, each timed | Same | Same | **Recorded deviation.** Default remains one batched call for all unique sources (strictly fewer round-trips, same dedup/timeout/conjunctive semantics). `authorizeMode: 'per-source'` implements the blueprint literally for customers whose auth API is single-source. | this pass |
| 22 | Registry contains no personal data | "keeps the 'registry is not a data processor' claim true" | — | — | **Qualified.** Opaque principals/source IDs are required guidance and are enforced by convention, but identifiers can still be personal data and the controller/processor role is a legal question. The docs keep the privacy-qualified position. | deviation (legal) |
| 23 | Rebuilding mappings from auth results | Explicitly rejected; use PITR + backfill | — | — | **A.** Backup/restore with tombstone replay plus quarantine/backfill tooling. | implemented |

## 2. Toolchain and scope conflicts

| Topic | Blueprint | Repository | Resolution |
|---|---|---|---|
| Workspace tooling | pnpm + Turborepo (A/B), Nx allowed (C) | npm workspaces + `tsc -b` project references | **Deviation.** Build order is already enforced by project references, CI is green, and this adds no orchestrator dependency. Revisit if build times justify it. |
| Package names | `shared-types`, `sdk`, `worker` | `@contextline/core` (types + SDK + registry), `@contextline/worker`, `@contextline/demo` | **Deviation.** Types are a module boundary inside core (`types.ts`, `validation.ts`) and the worker imports them; the SDK never imports worker code, which is the property the split was protecting. |
| Node version | 20 LTS | 22+ | **Superset.** Node 22 is a later LTS; CI pins 22. |
| PostgreSQL | 16 + pgvector | 17 (embedded 17.9 for local tests; pgvector 17 in CI) | **Superset.** Schema targets ≥15. |
| Local topology | Docker Compose required | Compose provided **and** a zero-Docker embedded cluster | **Superset.** The embedded path is what makes `npm run demo` work in restricted environments; Compose is qualified in CI. |
| Registry vs customer stores | Two separate databases | Separate tables in the demo DB; separate databases supported by configuration | **Partial.** Connectors take their own pool, so a separate customer database is a connection-string change; the demo keeps one cluster for zero-setup. |
| Latency gates | lookup p95 <2ms, total <5ms, warm <2.5ms at 1M rows | Measured, published, **not yet met** | **Honest target.** Gates are implemented as a benchmark report with pass/fail flags; a failing gate is reported, never hidden. See [validation](validation.md). |
| Control plane | Optional, post-MVP | Not built | **Agreed scope guard.** |

## 3. Decisions that were already right and are unchanged

Register-before-write with a revocation race check; fail-closed defaults (auth error, unregistered, registry unreachable, 500ms timeout); explicit audited fail-open; tenant-scoped keys and forced RLS; verified connector actions; dead letters as a durable registry state; the revoke-before-worker demo proof. These match A and are covered by tests.

One residual gap is documented rather than hidden: A Part 0 B2 says a registered-but-never-stored artifact is harmless. That is true for *serving*, but a storage write published **after** a deletion snapshot can still orphan a physical row. The publication fence/reconciliation requirement stays in the [threat model](threat-model.md).
