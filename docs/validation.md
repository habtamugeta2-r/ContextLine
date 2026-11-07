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
| `npm run test:unit` | **47/47 pass** | Validation, SDK policy, connector contracts, action matrix, jitter, storage refs, allow cache, quarantine buffer |
| `npm run test:postgres` | **41/41 pass** | Real temporary PostgreSQL cluster; 36 integration + 5 blueprint chaos scenarios |
| `npm run smoke` | Pass | Assets, docs route, health, tenant isolation, revocation, paused-worker enforcement, cleanup, reset, CSRF rejection, metrics |
| `npm run check` | Pass | Build + example typecheck + blueprint gates + unit + PostgreSQL + smoke in one release gate |
| `npm run typecheck:examples` | Pass | The five adoption examples compile against the real SDK |
| `npm run gates` | **7/7 pass** | SDK deps exactly `pg`; 17.5KB gzipped; SQL confined to the registry store and connectors |
| `npm run test:live` | **2 skipped, 0 passed** | Redis/pgvector environment variables absent; skips are not passes |
| `npm audit --omit=dev --audit-level=high` | Pass | `found 0 vulnerabilities` for production dependencies at record time |
| `npm run benchmark` | Completed | 1M-row / 50-tenant blueprint-scale run below |
| `npm run demo:cli` | Pass | Fresh temporary cluster; revocation/deletion/isolation scenario |
| Interactive HTTP checks | Pass | Snapshot/query/reset against the running demo server; `/api/metrics` exposes 8 TYPE headers |
| Quarantine CLI against the demo registry | Pass | Buffered hit invisible before flush, visible after; `quarantine list` shows it; `resolve` marks it resolved; missing `--tenant` exits 1 |
| Worker CLI against the demo registry | Pass | Env-driven startup, `/health`, 8 unique Prometheus TYPE headers (adds `contextline_connector_healthy`), 404 for unknown route, graceful stop |
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

Command: `BENCH_ROWS=1000000 BENCH_TENANTS=50 BENCH_ITERATIONS=10000 BENCH_CACHE=1 npx tsx scripts/benchmark.ts`.
Workload: **1,000,000 dependency rows across 50 tenants**, 5,000 artifacts per tenant, 4 roots per artifact,
10 candidates per request, 20 warmup requests, **10,000 measured calls per phase**. Timing includes the
single-round-trip dependency lookup, an immediate synthetic authorization callback, and the durable audit
write. It excludes vector search, network authorization, LLM inference, and run creation.

Full report: [benchmark-1m.json](benchmark-1m.json).

| Phase | p50 | p95 | max | Gate | Result |
|---|---|---|---|---|---|
| Backward lookup (1 round-trip) | 0.81ms | **1.16ms** | 17.87ms | p95 <2.0ms | **Met** |
| `filterAuthorized` end to end | 2.28ms | **3.18ms** | 36.20ms | p95 <5.0ms | **Met** |
| Warm allow cache | 2.31ms | 3.50ms | — | p95 <2.5ms | **Not met** |

Registration seeded 250,000 artifacts / 1,000,000 edges in 58.9s (~4,246 artifacts/s) using two set-based
bulk writes per 500-artifact batch.

**What changed.** The previous recorded run measured p95 **136.87ms** on a 1,000-artifact dataset. Two
defects caused it: reads opened a transaction and set the tenant GUC in separate round-trips, and
registration wrote rows one at a time. The hot read is now one call to a `SECURITY INVOKER` SQL function
that sets the tenant GUC before scanning, and registration is set-based. The `<5ms` budget is now met at
27x the previous data scale.

**Why the warm-cache gate is still missed.** The synthetic callback returns instantly, so caching removes
approximately zero work, while the durable audit write remains on the path. The cache gate is only
meaningful against a real network authorization service; it is reported, not enforced, in the nightly
workflow. This is a measurement limitation, not a claim that caching is ineffective.

**Limits.** Shared 2-vCPU sandbox hardware, sequential requests, one hot tenant, uniform root distribution.
The max values (17.87ms / 36.20ms) show the tail is not bounded. This is neither a production SLA nor a
controlled comparison; concurrency, pool contention, tenant skew, and real auth latency are untested.

## Remote CI qualification

GitHub Actions run [42396690030](https://github.com/habtamugeta2-r/ContextLine/actions/runs/42396690030) passed on `ubuntu-24.04` with Node 22, `pgvector/pgvector:pg17`, and `redis:7-alpine` services. It executed:

- Build, example typecheck, blueprint gates, unit tests, PostgreSQL tests, and HTTP smoke.
- Live Redis delete-by-default invalidation and opt-in TTL-preserving tombstones: **1/1 pass**.
- Live pgvector row deletion/idempotent verification: **1/1 pass**.
- Production dependency audit: pass.
- Docker image build: pass.

Getting CI green exposed and fixed two environment bugs: PostgreSQL Unix-socket paths can exceed the server limit in deep CI checkout directories, and nested `*.tsbuildinfo` files could make Docker's TypeScript build skip emitting worker output. The socket directory is now a short temp path, and the Docker context ignores all build-info files.

## Blueprint conformance

The three supplied blueprint passes are recorded in [blueprint/](blueprint/README.md), their
disagreements resolved in [blueprint-conflicts](blueprint-conflicts.md), and every requirement tracked
in [conformance](conformance.md): of 96 requirements, 80 met, 10 partial, 4 deliberate deviations,
1 deferred, 1 not met.

## Still not validated

- Local sandbox Redis/pgvector services: live tests were skipped locally; CI qualified them against service containers.
- Docker image run and full Compose stack with real application connector tables: CI built the image, but did not run the full Compose qualification stack.
- Production HA/failover, backup-restore replay, and real customer auth callbacks.
- Concurrent load: the benchmark is sequential; a 4-worker x 200-event soak and multi-client latency under contention are not yet scripted.
- The nightly benchmark workflow has been added but has not yet run on GitHub Actions.
- Browser visual/interaction testing beyond HTTP asset/API checks; no browser automation binary was available in the sandbox.

These gaps are also tracked in [roadmap](roadmap.md). A skipped or unavailable environment must never be reported as a passing qualification.

## Reproduce

```bash
npm ci
npm run check
npm run demo:cli
npm run benchmark
# Blueprint scale (about two minutes on the reference sandbox):
BENCH_ROWS=1000000 BENCH_TENANTS=50 BENCH_ITERATIONS=10000 BENCH_CACHE=1 npx tsx scripts/benchmark.ts
# Optional, with disposable services:
REDIS_URL=redis://localhost:6379 \
CONTEXTLINE_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/contextline_test \
CONTEXTLINE_TEST_PGVECTOR=1 npm run test:live
```

Record the date, environment, exact command, pass/skip counts, and benchmark distribution when repeating this validation. Update this document rather than relying on memory of an earlier run.
