# ContextLine: Engineering Research and End-to-End Implementation Blueprint

> **Provenance:** supplied by the project owner on 2026-11-07. This is version **A — Revised**, the authoritative pass. Reproduced as supplied. See [README](README.md) for precedence and [../blueprint-conflicts.md](../blueprint-conflicts.md) for differences against the two earlier passes.

This is the same request as before, so I re-reviewed the strategy document and the partial handbook once more. The result is the full blueprint, with no code, only structures, behaviors and data flows in prose. Items marked **Revised** are decisions I changed or added on this pass.

---

## Part 0: Research and Decisions

### A. Defects in the source design and the handbook, and the decision for each

| # | Problem found | Why it matters | Decision |
|---|---|---|---|
| 1 | The enforcement loop looks up sources once per candidate (N+1 queries). | 10 candidates means 10 round-trips, which breaks the 5ms budget. | One batched backward lookup per request. All candidate IDs go in as a single array and the registry answers in one round-trip. |
| 2 | Tenant isolation via a session variable on pooled connections. | A connection returned to the pool can carry the previous tenant's context, which is a cross-tenant leak. | The tenant is set inside the same statement or transaction that uses it, scoped to that transaction only. Every query also filters by tenant explicitly, so isolation does not rely on RLS alone. |
| 3 | Registration inserts rows one by one. | Ingesting 500 chunks becomes thousands of round-trips. | Bulk registration: at most 3 bulk upserts (sources, artifacts, dependencies) in a single transaction. |
| 4 | A worker that crashes leaves events stuck in `processing`. | Revocations silently never finish. | Lease-based locking. A claimed event has a lease expiry, the worker extends it with heartbeats, and the poller may reclaim any event whose lease has expired. |
| 5 | Retries redo work that already succeeded. | Wasted calls, noisy audit trail, risk on non-idempotent stores. | State is tracked per artifact. The forward lookup returns only artifacts still `active`, so a retry naturally skips finished ones. |
| 6 | Table names are built from `storage_ref`. | An attacker-controlled reference could point the worker at any table (injection). | A strict allowlist: a configured map from logical target name to a validated table and id column. Unknown targets raise a non-retryable error and go straight to the dead-letter queue. |
| 7 | Quarantine writes happen on the request path. | Adds latency to every unregistered hit. | Quarantine hits go into an in-memory buffer and are flushed in the background every 5 seconds or 100 items. |
| 8 | Primary keys lack `tenant_id`. | Two tenants using the same artifact ID would collide. | Every key and foreign key is tenant-scoped. |
| 9 | The handbook's registry tests and enforcement code have an unused results array and a race on the shared "unregistered" list. | Subtle bugs in the most security-critical function. | Enforcement is rewritten as a pure, sequential pipeline of 6 steps with no shared mutable state across parallel tasks. |

### B. New product-level decisions (Revised)

1. **Principal-scoped revocation vs source-wide events.**
   - The strategy document deletes all derivatives when one user (Sarah) loses access. That destroys the answers for every other authorized user.
   - **Decision:** two scopes.
     - *Principal-scoped* events (one user lost access) are handled by retrieval-time enforcement, plus invalidation only of cache and memory artifacts created for or by that principal.
     - *Source-wide* events (document deleted, GDPR erasure, retention expiry, reclassified to restricted, access revoked for everyone) run the full propagation matrix.
   - Each lifecycle event records which scope it has.
2. **Register first, then write.** The strategy document stores the artifact and then registers it. A crash between the two creates an unprotected orphan. **Decision:** register the intent first, then write to storage. A registered-but-never-stored artifact is harmless, and deletion is idempotent.
3. **Registration vs revocation race.** A source can be revoked while a pipeline is mid-flight. **Decision:** registration checks source status in the same transaction. If the source is already deleted or revoked, registration reports this and the artifact is queued for immediate deletion instead of being registered as active.
4. **The registry must not hold personal data.**
   - The document claims no PII, yet it stores affected principals as emails and source IDs that can contain names.
   - **Decision:** principals are stored as opaque identifiers or keyed hashes, and the docs tell customers to use opaque source IDs. This keeps the "registry is not a data processor" claim true.
5. **Auth cache across multiple app instances.** Purging the cache on a source event only clears the local process. **Decision:**
   - The cache is off by default.
   - When on, its TTL is capped at 30 seconds, and the guaranteed staleness bound is documented.
   - Only allow results are cached. Deny results are never cached, so a stale deny can only over-block briefly.
   - Cross-instance purge via Postgres notifications is deferred to v1.1.
6. **Do not rely on the auth callback to rebuild lost mappings.** The strategy document says backward lookups can be reconstructed from auth results. That is not reliable. **Decision:** rely on registry backups with point-in-time recovery, plus the quarantine and backfill tooling.
7. **Fail-closed everywhere.** The defaults are deny on auth error, deny for unregistered artifacts, deny when the registry is unreachable, and a 500ms auth timeout. Fail-open exists only as an explicit setting, and every use writes a warning to the audit trail.
8. **Scope guard.** v1 ships exactly: TypeScript SDK, Postgres registry, Node worker, connectors for pgvector, Redis and generic Postgres. The control plane is a later, optional part.

---

## Part 1: Workspace Foundation and Local Topology (Week 1)

**Goal:** a repo where anyone can clone, start, test and measure everything in a few commands, with the product's hard constraints enforced from day one.

**What it looks like**
- A single monorepo using pnpm workspaces and Turborepo.
- Three packages:
  - `shared-types` holds the vocabulary used by SDK and worker: reference formats, event types, status values, error classes, and the parser for storage references.
  - `sdk` is the customer-facing library.
  - `worker` is the background process.
- Supporting folders: `infra` (migrations, local containers, deployment notes), `examples` (one per adoption stage), `tests` (integration, chaos, performance), and `docs` (including a decisions folder with one short record per Part 0 decision).
- Local topology:
  - One Postgres 16 with pgvector.
  - Two separate databases inside it: the registry and a stand-in "customer application" database that holds embeddings, summaries and memory.
  - One Redis 7.
  - Health checks on all services, so tests wait until they are ready.

**Guideline**
1. Initialize the workspace with strict TypeScript, linting and formatting shared across packages.
2. Create the three packages with minimal public surfaces.
3. Build the local container set and a one-command "up, migrate, seed" script.
4. Write the CI pipeline with real service containers (not mocks).
5. Add three automatic CI gates:
   - the SDK's runtime dependency list must be exactly `pg`
   - the SDK's gzipped bundle must stay under 50KB
   - no code files outside the allowed locations touch storage tables directly

**TODO checklist**
- [ ] Workspace skeleton with the three packages. *Gives clear boundaries so the SDK never imports worker code.*
- [ ] Strict compiler settings and shared lint rules. *Catches the class of bugs that matter in security code.*
- [ ] Local containers with health checks. *Tests must never run against half-started databases.*
- [ ] Separate registry and customer-app databases. *Proves the registry works against stores it does not own.*
- [ ] One-command bootstrap (start, migrate, seed). *A new engineer should be productive in minutes.*
- [ ] CI gates for dependency list and bundle size. *Protects the "tiny, one dependency" promise automatically.*
- [ ] Decision records folder seeded with Part 0. *Prevents re-debating settled choices.*

**Done when:** a fresh clone reaches a green test run with one bootstrap command, and CI fails if a second runtime dependency is added to the SDK.

---

## Part 2: Dependency Registry (Weeks 1–2)

**Goal:** a durable, tenant-safe metadata store that answers two questions in under 2ms: *which sources produced this artifact* (backward) and *which artifacts depend on this source* (forward).

**What it looks like: five tables, metadata only**
1. **Sources.** One row per source version. It holds tenant, source ID, version, status (active, revoked, deleted, expired) and last-updated time. Key: tenant + source + version.
2. **Artifacts.** One row per artifact version. It holds tenant, artifact ID, type (embedding, cache, summary, memory), the storage reference, status (active, stale, deleted, pending review) and creation time. Key: tenant + artifact + version.
3. **Dependencies.** One row per (artifact version, source version) pair. Foreign keys to both parents include the tenant, so cross-tenant links are structurally impossible.
4. **Lifecycle events.** The outbox and audit log. Beyond the original fields it holds:
   - the event scope (principal-scoped or source-wide)
   - opaque principal references
   - a lease expiry
   - a retry count and next-retry time
   - progress counters and a detailed results document
5. **Quarantine manifest.** One row per unregistered artifact seen at retrieval, with first-seen, last-seen, hit count and a resolved flag. It drives the backfill.

**Indexes (what each one serves)**
- A backward-lookup index that *covers* the lookup, so the answer comes from the index alone with no table visit.
- A forward-lookup index by tenant and source.
- A partial worker-polling index containing only events that are pending, partial or processing.
- Tenant-and-time indexes for audit queries.

**Access model**
- Two database roles: an admin role for migrations, and an app role for the SDK and worker.
- RLS is enabled *and forced* on every table, so even table owners are subject to it.
- If no tenant is set, the policy returns nothing (fail-closed).

**Migrations:** an ordered runner with a record of what has been applied, guarded by an advisory lock so two deploys cannot migrate concurrently. Running it twice is a no-op.

**TODO checklist**
- [ ] Define the five tables with tenant-scoped keys. *Collision-proof identity across customers.*
- [ ] Constrain every status and type to a closed list. *Typos can't create undefined states.*
- [ ] Composite foreign keys including tenant. *Structural cross-tenant protection.*
- [ ] Covering backward-lookup index. *Makes the hot path an index-only scan.*
- [ ] Forward-lookup and partial polling indexes. *Fast propagation and a tiny polling set.*
- [ ] Two roles with forced RLS and fail-closed default. *Defense in depth against application bugs.*
- [ ] Migration runner with applied-history and advisory lock. *Safe for concurrent deployments.*
- [ ] Synthetic data generator (tenants, sources, artifacts, edges). *Needed for benchmarks in Part 6.*
- [ ] Query-plan review at 100K and 1M rows. *Proves the index design before anything depends on it.*

**Done when:** backward lookup of 10 artifacts takes under 1.5ms at 1M dependency rows with an index-only plan, and a deliberately wrong tenant returns zero rows.

---

## Part 3: Core SDK (Weeks 3–4)

**Goal:** a small library that makes the three capabilities usable in a few lines inside any AI pipeline.

**What it looks like: the public surface**
- **Client creation.** Takes the registry connection, default tenant, and the safety settings. It validates settings up front and rejects missing tenants. The connection pool is created lazily (first use) with 10 connections and a 200ms acquire timeout, so a registry outage fails fast.
- **Begin run.** Creates a request-scoped identity (principal, tenant, start time) used to correlate audit records.
- **Register derivation.** Takes a set of root sources and a set of artifacts and creates all links in one transaction. It is idempotent, and follows the register-first rule and the revocation-race check from Part 0.
- **Filter authorized.** The retrieval-path function, described below.
- **Assert can serve.** The single-artifact check for cache hits and memory reads, using the same logic.
- **Record source event.** Writes a lifecycle event, updates the source's status and purges any local auth-cache entries for that source, all in one transaction.
- **Close.** Flushes buffers and ends the pool.

**`filterAuthorized`, step by step**
1. Collect all candidate artifact IDs and run **one** batched backward lookup.
2. Split candidates into registered and unregistered.
3. Apply the unregistered policy. Deny and quarantine both exclude the candidate, and quarantine also drops an entry into the in-memory buffer.
4. Deduplicate the sources across all candidates, then check the optional cache (keyed by tenant, principal and source).
5. Call the customer's authorization callback once per unique source, in parallel, each under its own timeout. Errors and timeouts are resolved by the error policy (deny by default).
6. Keep a candidate only if **every** one of its sources is allowed (conjunctive rule). Preserve the original ranking and attach each survivor's source references so the caller can register downstream derivations against root sources.

**Error vocabulary:** a small hierarchy covering configuration problems, registry unavailable, auth timeout, auth failure and tenant missing. Each has a stable code so customers can alert on them.

**TODO checklist**
- [ ] Public type contracts, written first. *Everything else is built against a fixed interface.*
- [ ] Lazy pool with short acquire timeout. *No hanging if the registry is down.*
- [ ] Bulk `registerDerivation`. *Ingestion-speed registration.*
- [ ] Register-first and revoked-source handling. *Closes the orphan and race gaps.*
- [ ] Batched `filterAuthorized` with the 6 steps. *The performance-critical heart of the product.*
- [ ] Opt-in auth cache with allow-only caching. *Reduces load without caching denials.*
- [ ] `assertCanServe` sharing the same core. *One enforcement logic, two entry points.*
- [ ] `recordSourceEvent` as a single transaction. *Event, status and cache purge cannot diverge.*
- [ ] Quarantine buffer with background flush. *No request-path writes.*
- [ ] Error hierarchy and warning records for any fail-open use. *Makes dangerous configurations visible.*
- [ ] Unit tests for every policy combination. *The policy matrix is where security bugs hide.*

**Done when:** all policy combinations have tests, the SDK builds under 50KB gzipped, and filtering 10 candidates against 4 sources stays within the latency budget in the Part 6 benchmark.

---

## Part 4: Storage Connectors (Week 5)

**Goal:** a uniform, safe way for the worker to act on any storage system.

**What it looks like**
- Storage references have one fixed shape: connector type, target name, record ID, separated by colons. A shared parser rejects anything malformed.
- Every connector exposes four behaviors: **delete**, **invalidate**, **verify** and **health check**.
  - Delete and invalidate are idempotent.
  - Verify answers "is this really gone or marked?" by reading the store, never by trusting the write's success response.
- The **target allowlist** is configuration owned by the customer's operator: each logical target maps to a real table, an id column, and an optional status column. Names must pass a strict identifier check at startup. The worker refuses to start if the config is invalid.

**Built-in connectors**
- **pgvector:** delete removes the row by ID using a parameterized query. Invalidate marks a status column if present, otherwise falls back to delete.
- **Redis:** delete removes the key. Verify checks existence. There is no soft invalidation, only deletion.
- **Generic Postgres:** invalidate sets a status of stale. For agent memory it sets pending review instead, because memory may hold synthesized knowledge that needs a human decision.

**TODO checklist**
- [ ] Storage reference format and shared parser. *One definition of "where an artifact lives".*
- [ ] Connector contract document. *Lets customers write their own in a day or two.*
- [ ] Target allowlist with startup validation. *Eliminates the injection path.*
- [ ] pgvector connector. *The primary embedding store.*
- [ ] Redis connector. *Cache coverage.*
- [ ] Generic Postgres connector with the stale / pending-review distinction. *Covers summaries and memory.*
- [ ] Reusable connector conformance tests (idempotent delete, honest verify, unknown target rejected). *Every future connector must pass the same tests.*
- [ ] Authoring guide with a worked example. *Starts the connector ecosystem.*

**Done when:** all three connectors pass the shared conformance suite against real containers, and an unlisted target is refused without any database call.

---

## Part 5: Lifecycle Worker (Weeks 5–6)

**Goal:** make storage converge to a clean state after any source event, provably, and survive crashes along the way.

**What it looks like**
- **Poller.** Ticks every second and claims up to 5 events at a time, using row-level skip-locking so several workers never grab the same event. Priority order: GDPR erasure and revocations first, then deletions, retention, and updates last. An event is claimable if it is pending, or partial with its retry time reached, or processing with an expired lease.
- **Lease and heartbeat.** A claim sets a 60-second lease. The worker extends it every 20 seconds while working. A killed worker's events become claimable again within a minute.
- **Processor.** For each event it does a forward lookup of active artifacts for the source, then applies the action matrix below. After every action it calls verify. Only a verified result moves the artifact to its new status.
- **Retry.** Failed artifacts schedule the event for retry with backoff of 1s, 5s, 30s, 5m and 30m, each with about 10% random jitter. After 5 retries the artifact goes to the dead-letter path (status pending review, event marked partial or failed) and an alert metric fires.
- **Observability.** A small HTTP endpoint on port 9090 exposes metrics (queue depth, processing rate, failures, propagation latency, connector health) and a liveness check.
- **Shutdown.** On a stop signal the worker stops claiming, finishes in-flight events for up to 30 seconds, and releases anything left.

**Action matrix (source-wide events)**

| Event | Embedding | Cache | Summary | Memory |
|---|---|---|---|---|
| Deleted / GDPR erasure | Delete | Delete | Delete | Delete |
| Revoked for everyone / retention expired | Delete | Delete | Delete | Invalidate to pending review |
| Updated | Invalidate to stale | Delete | Invalidate to stale | Invalidate to stale |

For *principal-scoped* events the worker only touches cache and memory artifacts tied to that principal, and leaves shared embeddings alone (see Part 0, decision 1).

**Audit record:** each event ends with the counts of artifacts deleted, invalidated, pending review and failed, plus per-artifact action, result, verification time and reason where relevant.

**TODO checklist**
- [ ] Poller with skip-locking, priority and concurrency cap. *Safe parallelism and the right order of urgency.*
- [ ] Lease, heartbeat and reclaim logic. *Eliminates zombie events.*
- [ ] Action matrix as a single configuration table. *Auditors can read the policy in one place.*
- [ ] Mandatory verify after every action. *Never record success the store hasn't confirmed.*
- [ ] Per-artifact state updates inside the loop. *Makes retries skip completed work.*
- [ ] Backoff with jitter and a retry ceiling. *Handles brief outages without hammering stores.*
- [ ] Dead-letter handling and alert metric. *Failures become visible, not silent.*
- [ ] Principal-scoped handling path. *Prevents over-deletion.*
- [ ] Connector health checks feeding metrics. *Detects an outage before events fail.*
- [ ] Metrics and liveness endpoint. *Operators can see queue health.*
- [ ] Graceful shutdown with drain. *Deploys don't strand events.*

**Done when:** killing a worker mid-event leads to completion by another worker within about 70 seconds, with no artifact acted on twice after success.

---

## Part 6: Testing, Chaos and Benchmarking (Weeks 6–7)

**Goal:** turn the guarantees ("safe by default", "under 5ms") into repeatable evidence.

**What it looks like**
- **Unit layer:** policy matrices, parsers, backoff schedule, allowlist validation.
- **Integration layer** (real containers):
  - two tenants cannot see each other's rows, even with a deliberate mis-set tenant
  - four workers process 200 events with zero duplicate actions
  - registration is idempotent
- **Chaos scenarios** (each a scripted story with an expected outcome):
  1. **Lying storage:** delete reports success but data remains. Verify must catch it and retry.
  2. **Mid-flight worker kill:** another worker finishes the work after the lease expires.
  3. **Auth blackout:** the callback times out. Everything is denied, nothing leaks, and a warning is recorded.
  4. **Registry outage:** the SDK fails closed within the pool timeout.
  5. **Cascading derivatives:** a 4-hop chain (document, chunks, answer, summary, fact) is fully found by one forward lookup because everything is registered against the root.
- **Benchmark:** 1M dependency rows across 50 tenants, 10,000 calls with 10 candidates each over 4 sources, with a simulated auth callback.
  - Lookup p95 under 2.0ms.
  - End-to-end `filterAuthorized` p95 under 5.0ms.
  - Warm-cache p95 under 2.5ms.
  - A failed gate fails the build.

**TODO checklist**
- [ ] Unit suites for the pure logic. *Fast feedback on policy decisions.*
- [ ] Tenant isolation integration test with a deliberate fault. *Proves RLS and explicit filters both hold.*
- [ ] Multi-worker concurrency test. *Proves no double-processing.*
- [ ] The five chaos scenarios. *Demonstrate the resilience table in the strategy document.*
- [ ] Benchmark harness and result report. *Real numbers for sales and security reviews.*
- [ ] Performance gates in CI (nightly if too slow per commit). *Prevents slow regressions.*

**Done when:** all chaos scenarios pass, and the benchmark report shows every gate met on the reference hardware.

---

## Part 7: Demo, Rollout and Control Plane (Weeks 7–8, control plane optional)

**Goal:** make the value visible in five minutes and make adoption safe for real customers.

**What it looks like**
- **The Monday Morning demo**, in one terminal session:
  1. Ingest a confidential document that yields 18 derivatives across four stores.
  2. Ask a question and see the restricted answer.
  3. Record a revocation *without running the worker*, and ask again: enforcement already blocks every one of the 18.
  4. Start the worker and watch the cleanup and verification.
  5. Show the final audit record.

  Step 3 is the core proof: safety does not depend on cleanup.
- **Backfill and quarantine tooling.** A command-line tool that lists quarantined artifacts, helps assign their sources in batches, and moves teams from quarantine to deny.
- **Security-review kit.** A questionnaire answer template, an architecture one-pager, a data-flow description showing no content leaves the customer, and the audit-record guide.
- **Five adoption examples** matching the five adoption stages (ingestion registration, retrieval filtering, cache revalidation, lifecycle events, memory stores).
- **Optional control plane.** Receives only aggregate telemetry (counts, health), never source IDs or artifact references. The runtime keeps working if it is unreachable.

**TODO checklist**
- [ ] Demo script with the revoke-before-worker proof. *The single most convincing moment.*
- [ ] Five stage examples. *Each is a copy-paste adoption path.*
- [ ] Backfill and quarantine CLI. *Lets teams with existing data adopt without a big-bang migration.*
- [ ] Security-review answer kit. *This is what actually unblocks deals.*
- [ ] Operations guide (deploy, scale workers, back up, upgrade). *Makes it production-ready.*
- [ ] Control plane spike (telemetry and config only). *Only after everything above is done.*

**Done when:** a developer who has never seen the project completes the demo in under 5 minutes, and a security reviewer's five sample questions can each be answered from the kit.

---

## Timeline and Critical Path

| Weeks | Parts | Outcome |
|---|---|---|
| 1–2 | Parts 1–2 | Repo, local stack, registry meeting latency target |
| 3–4 | Part 3 | SDK with enforcement and registration |
| 5–6 | Parts 4–5 | Connectors and resilient worker |
| 6–8 | Parts 6–7 | Chaos evidence, benchmarks, demo, rollout kit |

**Critical path:** schema, then SDK enforcement, then worker propagation, then the end-to-end demo. Connectors can be built in parallel with the SDK once the storage-reference format is fixed in Part 1.

**Top risks to watch**
- **Latency.** Verify the lookup plan early (Part 2) rather than discovering slowness at benchmark time.
- **Scope creep.** Anything beyond the three capabilities and three connectors waits until after design partners.
- **Over-deletion.** The principal-scoped vs source-wide split must be tested with real customers' revocation patterns.
- **Customer misuse.** Fail-open settings and non-opaque source IDs need clear documentation and warnings.
