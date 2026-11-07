# Quickstart

## 1. Prerequisites

- Node.js **22 or newer** and npm.
- Linux x64 for the zero-configuration demo and temporary PostgreSQL test clusters. The demo uses the npm-distributed PostgreSQL 17.9 binaries from `@embedded-postgres/linux-x64`; it does not install system packages or require Docker.
- Approximately 200 MB for dependencies and local database/test files. `.contextline/`, `node_modules/`, and build output are ignored by Git.
- No OpenAI/Anthropic key, external authorization service, Redis server, or pgvector extension is required for the default demo.

macOS/Windows developers can still build the TypeScript packages and run unit tests. The bundled local cluster is Linux-x64-specific; use the CI configuration or connect the core/worker to your own PostgreSQL instance. A cross-platform demo bootstrap is a roadmap item.

## 2. Install and build

```bash
npm ci
npm run build
```

`npm ci` uses the committed lockfile. The PostgreSQL binary package has a postinstall step to restore library symlinks; do not disable lifecycle scripts for that dependency. If your policy forbids postinstall scripts, use an externally managed PostgreSQL service instead.

## 3. Start the interactive demo

```bash
npm run demo
```

The server binds to `0.0.0.0:3000` for container/live-preview compatibility. Its internal PostgreSQL cluster binds only to loopback on port `55432` and uses a short temporary Unix-socket directory to avoid PostgreSQL path-length limits. Data persists in `.contextline/demo-db/`.

```bash
PORT=3001 DEMO_DATABASE_PORT=55433 npm run demo
```

Only one demo process may own a data directory. Stop with Ctrl+C or SIGTERM. The handler stops the worker, HTTP server, pools, and PostgreSQL. If a previous process was killed without cleanup, see [operations](operations.md#local-demo-recovery).

**Security warning:** the demo has no login. Tenant/principal selectors are simulated trusted inputs. Use it only with synthetic data on a trusted network. Do not expose it as a production service.

## 4. Reproduce the failure and the fix

1. Select **Acme Corporation**, **Alice**, and ask “What were the Q3 revenue projections?”
2. Observe a cached answer containing the synthetic `$12.4M` figure. The cache depends on both the revenue source and the handbook; both are checked for Alice.
3. Click **Revoke selected principal's access**. The demo removes Alice's authoritative ACL grant and records `permission_revoked`.
4. Ask again. The cache is denied and revenue retrieval returns no authorized context. Bob's access is unchanged. No shared artifact is deleted by this principal-specific event.
5. Ask about the **employee handbook**. Alice still receives authorized handbook content.
6. Click **Pause worker**, then **Delete + propagate**. The source is marked deleted in the registry immediately; storage jobs remain queued.
7. Ask again. Revenue content is still blocked while cleanup is paused.
8. Click **Process once** (possibly twice if a queued audit-only event precedes deletion), or resume the worker. Inspect the deletion event: 18 affected, 18 processed, 18 verified, status `completed`.
9. Switch to **Other Corporation** and ask about revenue. Its synthetic `€2.1M` figure remains available to its authorized principal.

Use **Reset demo** to restore the selected tenant's synthetic data and audit history. Reset is a privileged demo operation, not an SDK API.

## 5. Terminal-only walkthrough

```bash
npm run demo:cli
```

This creates a fresh temporary PostgreSQL cluster and random free ports, runs the scenario, prints JSON evidence, and removes the cluster. It does not modify the interactive demo's database.

## 6. Run verification

```bash
npm run check
```

This runs the build, 35 unit tests, 28 real-PostgreSQL integration tests, and an HTTP smoke test. Counts are current for v0.1.0; use the test runner output as the authoritative count after changes.

Individual commands:

```bash
npm run test:unit
npm run test:postgres
npm run smoke
npm run benchmark
```

The benchmark is a local synthetic measurement, not a production SLA. Optional live Redis/pgvector tests are described in [testing](testing.md).

## 7. Use your own PostgreSQL registry

Provision a database and two roles:

- **Owner/migration role:** creates the schema and applies migrations. Never use it in the request path.
- **Runtime role:** `LOGIN NOSUPERUSER NOBYPASSRLS`, not the table owner, with only the grants described in [deployment](deployment.md).

```bash
export CONTEXTLINE_MIGRATION_DATABASE_URL='postgresql://owner:PASSWORD@db.example:5432/app'
export CONTEXTLINE_SCHEMA=contextline
npm run migrate
```

For a new runtime role, after migration:

```bash
export CONTEXTLINE_RUNTIME_ROLE=contextline_app
export CONTEXTLINE_RUNTIME_PASSWORD='a-long-random-secret-at-least-16-chars'
node deploy/provision-role.mjs
```

Then configure the application:

```bash
export DATABASE_URL='postgresql://contextline_app:PASSWORD@db.example:5432/app'
```

The SDK connects directly to PostgreSQL. There is no ContextLine HTTP API in the request path. The demo's `/api/*` routes belong only to the demo application.

## 8. Run a standalone worker

Copy `connectors.example.json`, adjust table names and connector IDs, and configure the stores your application actually uses. The example is a template; its tables are not created by the core migration.

```bash
export DATABASE_URL='postgresql://contextline_app:PASSWORD@db.example:5432/app'
export CONTEXTLINE_CONNECTORS_FILE=./connectors.json
export CONTEXTLINE_WORKER_TENANTS=acme-corp,other-corp
export REDIS_URL='rediss://default:PASSWORD@redis.example:6379'
npm run worker
```

Metrics and health are exposed on port `9090` (`/metrics`, `/health`). Restrict this endpoint to your monitoring network. See [deployment](deployment.md) and [operations](operations.md).

## 9. Container qualification stack

Docker is optional and is not used by the default demo. `Dockerfile` builds the core/worker runtime. `compose.yaml` starts PostgreSQL, Redis, a one-shot migration/role provisioner, and a worker. It does not create your application's derivative tables.

Set strong, URL-encoded passwords in `.env` as described in [deployment](deployment.md), then:

```bash
docker compose up --build
```

The container files are provided for reproducibility; this sandbox did not have a Docker daemon, so local validation used the real embedded PostgreSQL cluster instead. CI includes a container build step.

## Troubleshooting

| Symptom | Action |
|---|---|
| `initdb` cannot run as root | Run the demo as a non-root user. The helper never creates a system user or changes host ownership. |
| Demo port already in use | Set `PORT` and/or `DEMO_DATABASE_PORT`, or stop the previous owner. |
| `postmaster.pid` exists | Check whether PostgreSQL is still running; use `pg_ctl status/stop` against the demo data directory. Do not delete a PID file while the server is alive. |
| Binary symlinks missing | Reinstall with lifecycle scripts enabled, or run the binary package's documented symlink hydration step. |
| SDK returns no artifacts | Inspect access decisions for `unregistered`, `source_outdated`, `authorization_denied`, registry/audit diagnostics, and tenant/run identity. |
| Worker event stays partial | Expand the event. `pending_review` requires a human decision; `failed` is a dead letter; `retry` has a future `nextAttemptAt`. |
| Redis adapter rejects a key | Default isolation requires `storageRef` to start with the exact tenant ID followed by `:`. |
| Migration checksum mismatch | An applied SQL file changed. Restore the applied file and add a new migration; do not edit history to force it through. |
