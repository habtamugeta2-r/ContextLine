# Registry schema and data model

The authoritative DDL is [`packages/core/src/migrations/001_registry.sql`](../packages/core/src/migrations/001_registry.sql). It targets PostgreSQL 15+; local tests use PostgreSQL 17.9. The default schema is `contextline`.

## 1. Why seven tables instead of four

The supplied draft described four domain tables. That is enough to express sources, artifacts, dependencies, and an aggregate event, but not enough for the implementation's per-artifact retry/lease/verification state and per-request access evidence. This build keeps those four concepts and adds three operational tables:

| Table | Role |
|---|---|
| `sources` | Versioned source identity and source-wide lifecycle state |
| `artifacts` | Versioned derivative identity, type, connector, storage reference, serving state |
| `dependencies` | Root-source edges for each artifact version |
| `lifecycle_events` | Durable source event/outbox and aggregate progress |
| `lifecycle_jobs` | One durable action per event/artifact, attempts, leases, fencing, verification, history |
| `access_runs` | Trusted tenant/principal context for a retrieval run |
| `access_decisions` | Per-candidate authorization outcome and reason |

`schema_migrations` is an owner-only migration ledger, not a tenant data table.

## 2. Keys and invariants

### Sources

Primary key: `(tenant_id, source_id, version)`.

- `version > 0`.
- `status`: `active | revoked | deleted | expired`.
- `is_current`: exactly one current version per tenant/source, enforced by a partial unique index.
- `updated_at` records lifecycle changes.

`is_current` is a freshness marker, not an availability flag. A current source can be deleted or revoked. An old source version can remain `active` but fail the default freshness check.

Principal-specific permission changes do not alter this table. The authoritative ACL lives outside ContextLine. `source_restricted` is the explicit source-wide denial event.

### Artifacts

Primary key: `(tenant_id, artifact_id, version)`.

- `artifact_type`: `embedding | cache | summary | memory | other`.
- `connector_id`: operator-configured routing key, not SQL or a URL credential.
- `storage_ref`: opaque location understood by that connector.
- `status`: `active | stale | deleted | pending_review`.
- `created_at`, `updated_at`.

Identity, type, connector, storage reference, and root set are immutable through the registration API. Status is mutable through verified lifecycle work. A deleted version is a tombstone. New content requires a new artifact version/identity and a reviewed publication path.

### Dependencies

Primary key: `(tenant_id, artifact_id, artifact_version, source_id, source_version)`.

Foreign keys include tenant ID on both sides:

```sql
FOREIGN KEY (tenant_id, artifact_id, artifact_version)
  REFERENCES artifacts(tenant_id, artifact_id, version)
FOREIGN KEY (tenant_id, source_id, source_version)
  REFERENCES sources(tenant_id, source_id, version)
```

Edges point to root sources. `derivedFrom` is resolved at registration; intermediate graph edges are not persisted. An artifact can have multiple roots. Authorization requires all of them. Empty provenance is denied by the SDK.

### Lifecycle events

Primary key: `(tenant_id, event_id)`. Unique idempotency scope: `(tenant_id, idempotency_key)`.

Fields include source/version, event type, affected principals, affected/processed counts, `jobs_ready`, request fingerprint, JSONB details, and created/started/completed timestamps. Status is `pending | processing | completed | partial | failed`.

The request fingerprint detects reuse of an idempotency key with different semantics. `jobs_ready` distinguishes an unmaterialized event from an event with zero storage jobs. Principal permission events are audit-only and complete without jobs.

### Lifecycle jobs

Primary key: `(tenant_id, job_id)`. Unique work item: `(tenant_id, event_id, artifact_id, artifact_version)`.

- `action`: `delete | invalidate | flag`.
- `status`: `pending | processing | retry | completed | pending_review | failed`.
- `attempts`, `max_attempts` (default 6 total attempts).
- `next_attempt_at`, `lease_until`, `lease_token`.
- `last_error_code`, `verified_at`, bounded JSONB `history` (last 20 entries).

A claim increments attempts and installs a fresh UUID lease token. Completion requires the current token and `processing` state. Expired processing jobs can be reclaimed. `failed` is the durable dead-letter state. Review acknowledgement completes the flag workflow but does not change the artifact's blocked state or invent a verification timestamp.

### Access runs and decisions

`access_runs` key: `(tenant_id, run_id)`, with principal and creation time. `access_decisions` key: `(tenant_id, decision_id)`, foreign key to the run.

Each decision stores artifact ID/version, allowed boolean, outcome (`allowed | denied | skipped`), reason, root references as JSONB, duration, and timestamp. It does not store candidate content. Runtime grants are append-only for both tables.

## 3. Indexes

| Index | Purpose |
|---|---|
| `sources_one_current` | Enforce one current version per tenant/source |
| `sources_tenant_status` | Tenant lifecycle views |
| `artifacts_tenant_type` | Type/status inventory |
| `dependencies_by_source` | Forward lookup for propagation |
| `dependencies_by_artifact` | Backward lookup for enforcement |
| `events_claim` | Partial index for active event processing |
| `events_source`, `events_tenant` | Audit history |
| `jobs_claim` | Due pending/retry/expired processing work |
| `jobs_event`, `jobs_dead_letter` | Progress and operator queues |
| `decisions_run`, `decisions_artifact`, `decisions_review` | Run evidence, artifact history, quarantine backfill manifest |

The backward lookup is one batched query joining artifacts, dependencies, and sources. It is not one query per chunk. Actual plans depend on data size, statistics, hardware, and connection latency; the draft's millisecond and database-size figures are targets, not measurements.

## 4. Row-level security

All seven tenant tables have RLS enabled and forced. Policies constrain both reads and writes:

```sql
CREATE POLICY tenant_isolation ON dependencies
USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''))
WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), ''));
```

Every SDK transaction sets the GUC with `set_config(..., true)` so it is transaction-local and cannot leak through a pooled connection. Missing tenant context yields no visible rows. Superusers and `BYPASSRLS` roles bypass policies regardless of `FORCE`; runtime role provisioning rejects them.

RLS is defense in depth, not a substitute for authenticating the application principal. A compromised runtime can still lie about which tenant it sets. Protect credentials and derive tenant server-side.

## 5. Transactions and race handling

- Registration locks root source rows `FOR SHARE` in sorted order before inserting artifacts/edges.
- Source events lock source versions `FOR UPDATE` in the same order before changing lifecycle state and writing the outbox event.
- Event materialization locks the source before snapshotting dependencies.
- New artifacts cannot reference deleted/revoked/expired/noncurrent roots, closing the late-registration gap after a lifecycle snapshot.
- Artifact/dependency inserts and exact-retry checks are transactional. Conflicting immutable fields roll back the whole registration.
- Job claims use `FOR UPDATE SKIP LOCKED`; external connector calls occur after the claim transaction commits.
- Job completion and aggregate event updates are transactional and fenced by lease token. Aggregate refreshes lock the event row so concurrent job completions cannot publish a stale processing snapshot.

This coordinates registry state, not external storage writes. Publication fencing/reconciliation remains an application responsibility.

## 6. Migrations

`migrateRegistry`:

1. Takes a PostgreSQL advisory lock.
2. Creates the configured schema and migration ledger if needed.
3. Reads sorted numbered SQL assets.
4. Verifies SHA-256 checksums of already-applied files.
5. Applies new migrations and records checksums in one transaction.

Never edit an applied migration. Add a new numbered migration and re-run grants if new tables are introduced. The current `grantRuntimeRole` helper grants only the seven v0.1 tables; future migrations must update it deliberately. Back up before migration and test restore in staging.

## 7. Retention, growth, and partitioning

There is no automatic audit deletion or retention scheduler in v0.1.0. Define retention with privacy/security owners, export required evidence, and purge through a privileged, audited maintenance process. Do not grant the runtime role core `DELETE` just to make cleanup convenient.

Growth is roughly artifacts × average roots, plus access decisions per governed retrieval. Audit volume can dominate storage. The draft's 100K–100M artifact table is a planning hypothesis. Before partitioning, measure query plans, index bloat, autovacuum, audit write rate, and tenant skew. Tenant hash partitioning and read replicas are future work; they require migration and RLS regression tests.
