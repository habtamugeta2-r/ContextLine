# Changelog

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
