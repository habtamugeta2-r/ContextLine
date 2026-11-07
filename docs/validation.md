# Validation results

**Recorded:** 2026-11-07. This file separates observed Arena sandbox results from remote GitHub Actions results. Neither is a production certification or a guarantee about other environments.

## Environment

- Node.js `v22.22.3`, npm `10.9.8`.
- Linux x64; benchmark reported Intel Xeon @ 2.60GHz, 2 CPUs, 4 GiB memory.
- PostgreSQL `17.9` from `@embedded-postgres/linux-x64` for local tests/demo.
- No Docker daemon, Redis server, or pgvector-enabled external PostgreSQL service was available for local qualification.

## Commands actually executed

| Command | Result | Evidence |
|---|---|---|
| `npm run build` | Pass | Strict TypeScript build and asset copy |
| `npm run test:unit` | **35/35 pass** | Validation, SDK policy, connector contracts |
| `npm run test:postgres` | **28/28 pass** | Real temporary PostgreSQL cluster; RLS/grants/races/worker/audit |
| `npm run smoke` | Pass | Assets, docs route, health, tenant isolation, revocation, paused-worker enforcement, cleanup, reset, CSRF rejection, metrics |
| `npm run check` | Pass | Build + unit + PostgreSQL + smoke in one release gate |
| `npm run test:live` | **2 skipped, 0 passed** | Redis/pgvector environment variables absent; skips are not passes |
| `npm audit --omit=dev --audit-level=high` | Pass | `found 0 vulnerabilities` for production dependencies at record time |
| `npm run benchmark` | Completed | Synthetic durable-audit microbenchmark below |
| `npm run demo:cli` | Pass | Fresh temporary cluster; revocation/deletion/isolation scenario |
| Interactive HTTP checks | Pass | Snapshot/query/reset against the running demo server |
| Worker CLI against the demo registry | Pass | Env-driven startup, `/health`, unique Prometheus TYPE headers, 404 for unknown route, graceful stop |
| GitHub Actions CI | **Pass** | Run [42396690030](https://github.com/habtamugeta2-r/ContextLine/actions/runs/42396690030) on commit `3929a73`: build, unit, PostgreSQL, smoke, live connectors, audit, container build |

The PostgreSQL suite includes append-only audit enforcement: the runtime role receives PostgreSQL error `42501` when attempting to update `access_decisions`. It also verifies that cross-tenant foreign-key writes fail, stale lease tokens cannot commit, false verification retries, concurrent job completions cannot leave a stale event aggregate, and review acknowledgement leaves the artifact blocked.

## End-to-end demo evidence

The terminal walkthrough and interactive workflow establish this sequence with synthetic data:

1. Alice's revenue query returns a cached answer only after both revenue and handbook roots authorize (`authorizedCount: 1`, `cacheHit: true`).
2. After Alice's principal-specific revocation, the same query returns no revenue context (`authorizedCount: 0`); shared artifacts are not deleted by that event.
3. Source deletion blocks governed retrieval before cleanup completes.
4. Verified deletion processes **18 affected / 18 processed** Acme revenue derivatives; handbook artifacts remain.
5. The other tenant's identically named source remains isolated.

The HTTP smoke test additionally pauses the worker to prove enforcement does not depend on cleanup completion, then processes the queue and checks storage counts. It rejects a cross-site mutation with HTTP 403.

## Benchmark

Command: `npm run benchmark`. Workload: 1,000 registered artifacts, 3 roots each, 20 candidates per request, 20 warmup requests, 100 measured sequential requests. Timing includes dependency lookup, an immediate synthetic authorization callback, and durable audit writes. It excludes vector search, network authorization, and LLM inference.

Latest recorded run after the final hardening pass:

```json
{
  "date": "2026-11-07T17:09:28.745Z",
  "p50Ms": 121.50,
  "p95Ms": 136.87,
  "maxMs": 199.96
}
```

**Interpretation:** the original `<5ms p95` aspiration is **not achieved** by this local durable path. The result is specific to this sandbox and workload; it is neither a production SLA nor a controlled comparison. Profiling, realistic network/auth latency, concurrency, pool contention, tenant skew, and storage/audit tuning are required before making performance claims. Do not cite earlier pre-batching or pre-hardening runs as the current result.

## Remote CI qualification

GitHub Actions run [42396690030](https://github.com/habtamugeta2-r/ContextLine/actions/runs/42396690030) passed on `ubuntu-24.04` with Node 22, `pgvector/pgvector:pg17`, and `redis:7-alpine` services. It executed:

- Build, 35 unit tests, 28 PostgreSQL tests, and HTTP smoke.
- Live Redis TTL/tombstone/delete verification: **1/1 pass**.
- Live pgvector row deletion/idempotent verification: **1/1 pass**.
- Production dependency audit: pass.
- Docker image build: pass.

Getting CI green exposed and fixed two environment bugs: PostgreSQL Unix-socket paths can exceed the server limit in deep CI checkout directories, and nested `*.tsbuildinfo` files could make Docker's TypeScript build skip emitting worker output. The socket directory is now a short temp path, and the Docker context ignores all build-info files.

## Still not validated

- Local sandbox Redis/pgvector services: live tests were skipped locally; CI qualified them against service containers.
- Docker image run and full Compose stack with real application connector tables: CI built the image, but did not run the full Compose qualification stack.
- Production HA/failover, backup-restore replay, real customer auth callbacks, and large-scale load.
- Browser visual/interaction testing beyond HTTP asset/API checks; no browser automation binary was available in the sandbox.

These gaps are also tracked in [roadmap](roadmap.md). A skipped or unavailable environment must never be reported as a passing qualification.

## Reproduce

```bash
npm ci
npm run check
npm run demo:cli
npm run benchmark
# Optional, with disposable services:
REDIS_URL=redis://localhost:6379 \
CONTEXTLINE_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/contextline_test \
CONTEXTLINE_TEST_PGVECTOR=1 npm run test:live
```

Record the date, environment, exact command, pass/skip counts, and benchmark distribution when repeating this validation. Update this document rather than relying on memory of an earlier run.
