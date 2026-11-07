# Changelog

## Unreleased — documentation only

- Recorded the supplied three-topic research report verbatim under `docs/external/` and audited it in
  [research-audit](research-audit.md): 31 claims checked, 11 verified, 11 corrected, 6 unverifiable,
  3 structurally defective. Key correction: Ethereum's execution-sharding plan was cancelled and
  PeerDAS shipped in December 2025, so the report's scaling premise and its "shard-compatible contracts"
  advice are obsolete. No product code changed.

## 0.2.0 — 2026-11-07 (blueprint conformance)

Acts on the three supplied blueprint passes; the **Revised** pass governs conflicts.

### Added
- `docs/blueprint/` records the authoritative blueprint; `docs/blueprint-conflicts.md` resolves every
  disagreement between the three passes; `docs/conformance.md` tracks 96 requirements with evidence.
- Migration 002: covering backward index, `artifacts.owner_principal`, `lifecycle_events.scope`,
  `quarantine_manifest`, and the `lookup_artifacts` security-invoker function.
- Single-round-trip hot read; set-based bulk registration (at most 3 writes, 500-artifact batches);
  optional `createSources`.
- Principal-scoped propagation, the exported action matrix, retry jitter, non-retryable dead letters,
  job heartbeats, connector-health metrics, and a bounded graceful drain.
- Opt-in allow-only auth cache (30s cap), `authorizeMode: 'per-source'`, buffered quarantine with
  `flushQuarantine()`/`close()`, and the quarantine backfill CLI.
- Canonical `connector:target:record` parser; pgvector invalidation falls back to deletion;
  memory invalidation writes `pending_review`; Redis invalidation deletes by default.
- `npm run gates` (SDK deps, gzipped size, storage-access boundary), `npm run typecheck:examples`,
  five adoption-stage examples, five chaos scenarios, and a nightly benchmark workflow.

### Changed
- **`filterAuthorized` p95 fell from 136.87ms to 3.18ms** at 27x the data scale (1M dependency rows,
  50 tenants, 10,000 measured calls). Backward-lookup p95 is 1.16ms.
- Source-wide restriction/retention now **delete** embeddings, caches, and summaries (previously
  invalidated); `document_updated` deletes caches and marks other types stale.
- Principal revocation now propagates to that principal's cache and memory instead of being audit-only.
- Tests: 47 unit, 41 PostgreSQL. The Redis live test covers both invalidation modes.

### Fixed
- A `set_config` CTE cannot establish tenant context under RLS: PostgreSQL evaluates the policy as a
  one-time filter before the CTE runs, so the read silently returns zero rows. The hot path uses a
  `SECURITY INVOKER` function instead, which is both correct and one round-trip.

## 0.1.0 — 2026-11-07

Initial working reference implementation recorded in the repository.

### Added
- TypeScript core SDK with versioned root-source registration, transitive root flattening, multi-source all-root authorization, strict callback validation, fail-closed defaults, quarantine, and durable access decisions.
- PostgreSQL registry with seven tenant-scoped tables, forced RLS, composite foreign keys, least-privilege runtime grants, append-only audit tables, and checksummed migrations.
- Lifecycle worker with transactional outbox materialization, SKIP LOCKED claims, expiring leases, fencing tokens, bounded retries, dead letters, review acknowledgement, and connector verification.
- PostgreSQL/pgvector/Redis connectors, custom connector interface, worker CLI, connector configuration example, and optional live-service tests.
- Interactive synthetic demo, terminal walkthrough, HTTP smoke test, and reproducible benchmark.
- Dockerfile, Compose qualification stack, role-provisioning helper, CI workflow, and dependency-update configuration.
- Engineering, security, operations, research, product-strategy, requirements, decision, roadmap, and validation documentation.

### Hardening and corrections during implementation
- Principal-specific revocation separated from source-wide deletion/restriction.
- Runtime audit/lineage tables made append-only under the runtime role.
- Redis tenant-prefix enforcement added by default.
- Registration/publication residual race documented explicitly.
- Review acknowledgement added without restoring blocked artifacts.
- Audit decisions batched into one insert per enforcement call.
- Worker tenant drain scoped to the requested tenant; Prometheus TYPE headers emitted once per metric.
- Event aggregate refreshes serialized under an event row lock to prevent stale concurrent completion snapshots.
- Demo documentation route corrected for uppercase filenames.
- Embedded PostgreSQL uses a short temporary socket directory for deep CI checkout paths.
- Docker runtime installs production dependencies separately and ignores nested TypeScript build-info files.
- CI pinned to Ubuntu 24.04/current actions and passed end-to-end, including live Redis/pgvector and container build.
- Unsupported market/legal/latency absolutes replaced with evidence labels and measured results.

### Known limitations
- Hosted control plane, SSO, billing, dynamic tenant discovery, and broad connector coverage are not implemented.
- Local durable-audit benchmark p95 is about 137ms; the draft `<5ms` target is unmet.
- Local sandbox Redis/pgvector services and Docker runtime were unavailable; remote CI qualified live connectors and image build. Full Compose runtime, production HA, and real customer auth integration remain open.
- Backups, model weights, downstream copies, prompt injection, and legal compliance remain outside the core guarantee.
