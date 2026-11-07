# Deployment guide

## 1. Topology and supported scope

The supported reference topology is customer-managed Node.js applications using the SDK, a PostgreSQL registry, and one or more worker processes near their derivative stores. There is no hosted control plane, managed billing service, or SaaS data path in this release.

Run application replicas and workers separately. Scale workers horizontally against the same registry. Keep PostgreSQL credentials, storage credentials, and administrative interfaces inside your private network. Use TLS for PostgreSQL and Redis where applicable.

The interactive demo is not a production deployment artifact. It owns a local PostgreSQL cluster and has no authentication. The Docker runtime targets the core/worker CLIs.

## 2. PostgreSQL roles

Use separate owner and runtime roles.

```sql
-- Run as a database administrator; replace the password through your secret manager.
CREATE ROLE contextline_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'REPLACE_OWNER_SECRET';
CREATE ROLE contextline_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'REPLACE_APP_SECRET';
GRANT CONNECT ON DATABASE your_database TO contextline_owner, contextline_app;
```

The owner creates the schema through migration tooling:

```bash
CONTEXTLINE_MIGRATION_DATABASE_URL='postgresql://contextline_owner:SECRET@db/app' \
CONTEXTLINE_SCHEMA=contextline npm run migrate
```

Provision least-privilege runtime grants:

```bash
CONTEXTLINE_MIGRATION_DATABASE_URL='postgresql://contextline_owner:SECRET@db/app' \
CONTEXTLINE_RUNTIME_ROLE=contextline_app \
CONTEXTLINE_RUNTIME_PASSWORD='REPLACE_APP_SECRET' \
node deploy/provision-role.mjs
```

The helper uses PostgreSQL `format(%I/%L)` for safe role/password quoting, rejects invalid role names, and calls `grantRuntimeRole`. It can update an existing role's password. It does not grant schema ownership, superuser, BYPASSRLS, core DELETE, or migration-ledger access.

Verify:

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname IN ('contextline_owner','contextline_app');
```

The runtime must be non-owner, non-superuser, NOBYPASSRLS. `FORCE ROW LEVEL SECURITY` alone is not enough against privileged roles.

## 3. Application configuration

The SDK uses a `pg.Pool` supplied by your application. Recommended starting points, to be tuned under load:

- `max`: bounded per replica so total connections fit PostgreSQL capacity.
- `connectionTimeoutMillis`: short enough to fail closed promptly.
- `statement_timeout`: bounded registry queries/audit writes.
- TLS configuration appropriate to your provider.
- Secret injection from your secret manager, not source control.

```bash
DATABASE_URL=postgresql://contextline_app:SECRET@db/app
CONTEXTLINE_SCHEMA=contextline
```

Every application request must derive tenant/principal from trusted authentication state. Do not accept them directly from an untrusted client body. The demo does accept selectors because it is explicitly synthetic and unauthenticated.

## 4. Worker environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | Required | Runtime registry connection |
| `CONTEXTLINE_SCHEMA` | `contextline` | Registry schema |
| `CONTEXTLINE_CONNECTORS_FILE` | Required | Operator connector JSON |
| `CONTEXTLINE_WORKER_TENANTS` | Required | Comma-separated explicit tenant allowlist |
| `REDIS_URL` | If Redis configured | Redis connection, preferably `rediss://` |
| `CONTEXTLINE_POOL_SIZE` | 10 | Worker PostgreSQL pool |
| `CONTEXTLINE_BATCH_SIZE` | 20 | Jobs claimed per tenant pass, 1–100 |
| `CONTEXTLINE_CONCURRENCY` | 4 | Connector operations in parallel, 1–20 |
| `CONTEXTLINE_INTERVAL_MS` | 500 | Idle polling interval |
| `CONTEXTLINE_LEASE_MS` | 60000 | Job visibility lease |
| `CONTEXTLINE_OPERATION_TIMEOUT_MS` | 10000 | Per connector operation timeout |
| `CONTEXTLINE_MAX_ATTEMPTS` | 6 | Total attempts before dead letter, 1–20 |
| `CONTEXTLINE_METRICS_PORT` | 9090 | `/metrics` and `/health` |

Retry delays default to 1s, 5s, 30s, 5m, 30m. The lease must exceed twice the operation timeout plus database margin. The worker validates this at startup.

```bash
node --env-file=.env packages/worker/dist/cli.js
```

The CLI does not silently load `.env`; use Node's explicit `--env-file` or your orchestrator's environment injection. npm scripts also do not auto-load secrets.

The worker binds metrics to `0.0.0.0` for container compatibility. Restrict access with network policy/firewall or a private interface. Tenant labels can be sensitive; do not publish metrics publicly.

## 5. Connector provisioning

The core migration does not create your vector/cache/memory tables. Provision them in the application schema and configure the exact connector IDs used during registration. See [connectors](connectors.md).

Use least-privilege storage credentials. A PostgreSQL connector needs SELECT/DELETE/UPDATE only on configured derivative tables. Redis needs the commands used by the adapter (GET/DEL/EVAL and the script's SET/EXISTS behavior) on the intended keyspace. Do not share administrative credentials with the model runtime.

## 6. Docker and Compose

`Dockerfile` is a multi-stage Node 22 slim build. It compiles TypeScript, copies migration assets, prunes development dependencies, and runs as the non-root `node` user. The default command starts the worker. Migration is a separate one-shot command.

`compose.yaml` provides a local qualification stack:

- PostgreSQL 17 with a persistent volume.
- Redis 7 with password authentication and a persistent volume.
- One-shot migration plus runtime-role provisioning.
- Worker with the example connector file mounted read-only.
- Metrics bound to host loopback only.

Create `.env` with strong secrets (URL-encode special characters in embedded URL passwords):

```dotenv
CONTEXTLINE_OWNER_PASSWORD=replace-with-long-random-owner-secret
CONTEXTLINE_APP_PASSWORD=replace-with-long-random-app-secret
REDIS_PASSWORD=replace-with-long-random-redis-secret
CONTEXTLINE_WORKER_TENANTS=acme-corp
```

Then:

```bash
docker compose up --build
```

The example connector tables still need to exist before processing real jobs. Compose is not HA, does not configure TLS between local services, and is not a production security baseline. The sandbox had no Docker daemon; container build/run was not locally executed. CI includes a build step, and operators must qualify the full stack in their environment.

## 7. Production readiness checklist

### Identity and network
- [ ] Authenticated principal and server-derived tenant on every governed path.
- [ ] Authoritative batch authorization callback tested against real revocations.
- [ ] Private registry/storage endpoints; TLS and certificate validation enabled.
- [ ] Administrative APIs and metrics restricted to authorized operators/monitoring.
- [ ] Demo server and demo credentials absent from production.

### Data and coverage
- [ ] Inventory of every derivative store and serving path.
- [ ] Root provenance registered before publication; publish fences/reconciliation implemented.
- [ ] Cache/memory/agent reads revalidated, including semantic-cache hits.
- [ ] Unknown-provenance deny/quarantine rollout plan and backfill completion criteria.
- [ ] Connector tenant boundaries and verification semantics tested on actual services.

### Registry and worker
- [ ] Runtime role non-owner, NOSUPERUSER, NOBYPASSRLS; grants verified.
- [ ] Migration checksums and backup/restore tested.
- [ ] Lease/timeout/retry settings matched to store latency and consistency.
- [ ] Dead-letter and review alerts routed to an on-call owner.
- [ ] Queue depth, oldest event age, failure rate, and audit failures monitored.
- [ ] Horizontal worker and crash/reclaim tests run in staging.

### Privacy and operations
- [ ] Identifier/audit privacy review and retention schedule approved.
- [ ] Erasure scope includes backups, replicas, downstream recipients, traces, and legal exceptions.
- [ ] Incident runbook and security questionnaire evidence reviewed.
- [ ] Load test with realistic tenant skew, source fan-out, auth latency, and audit volume.
- [ ] Dependency/container vulnerability scanning and upgrade process enabled.

## 8. Availability and scaling

The registry is in the serving path. Use managed PostgreSQL HA or your standard HA pattern, bounded pools, and tested failover. Fail-closed enforcement means registry/auth outages can disable AI features; this is intentional. Define product fallback behavior that does not serve ungoverned content.

Workers can scale horizontally, but the current tenant list is static configuration. Tenant onboarding requires updating the worker deployment or running a dedicated worker. Dynamic tenant discovery/control-plane configuration is future work.

The draft's `<5ms p95` and 100M-artifact figures are not release guarantees. Measure the complete path with your auth service, network, pool contention, audit writes, and storage fan-out. See the reproducible [benchmark script](../scripts/benchmark.ts) and [validation results](validation.md).
