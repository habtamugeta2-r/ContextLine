# Testing and validation

## 1. Test layers

| Command | Environment | Coverage |
|---|---|---|
| `npm run build` | Node 22, TypeScript 5.9 | Strict type checking, declarations, migration/dashboard asset copy |
| `npm run test:unit` | In-memory fakes | Input bounds, SDK policy matrix, audit behavior, connector SQL/Redis contracts |
| `npm run test:postgres` | Real temporary PostgreSQL 17.9 | Migrations, RLS, grants, transactions, races, worker leases/retries/verification, tenant isolation |
| `npm run smoke` | Real HTTP server + temporary PostgreSQL | Dashboard assets/docs, API workflow, CSRF rejection, paused-worker enforcement, cleanup/reset, metrics |
| `npm run demo:cli` | Fresh temporary PostgreSQL | End-to-end synthetic revocation/deletion scenario with JSON evidence |
| `npm run test:live` | Optional real Redis/pgvector | Redis TTL/tombstone/delete and pgvector row deletion/verification; skips without environment |
| `npm run benchmark` | Temporary PostgreSQL | Local p50/p95/max enforcement latency with durable audit writes |
| Worker CLI qualification | Env-driven Node process | Startup, connector health, metrics, unknown-route handling, graceful stop |
| `npm run check` | Build + unit + PostgreSQL + smoke | Default release gate |

Current default suites contain **47 unit tests and 41 PostgreSQL tests** (36 integration + 5 chaos scenarios), plus the HTTP smoke workflow, the example typecheck, and the blueprint gates. Use runner output after changes as the authoritative count.

## 2. Security-focused cases

The suites exercise:

- All-root AND authorization and deduplicated callback batching.
- Unknown provenance deny/quarantine/explicit rollout allow.
- Known tombstones cannot be resurrected by unknown-artifact allow overrides.
- Stale/pending-review/empty-provenance artifacts denied.
- Deleted/revoked/expired roots denied even with permissive auth.
- Outdated versions denied by default; explicit freshness override bounded.
- Auth timeout, exception, missing/extra/nonboolean results fail closed.
- Registry failure denies; required audit failure blocks response.
- Explicit fail-open/skip/best-effort behavior is distinguishable in tests/audit.
- Candidate payloads absent from durable decisions.
- Tenant-inclusive foreign keys and wrong-tenant RLS writes rejected.
- Runtime role cannot bypass RLS, delete/update audit rows, or read migration history.
- Cross-tenant Redis keys rejected by default.
- Immutable artifact identity/provenance and idempotent concurrent registration.
- Transitive root flattening and unknown-parent rejection.
- Principal revocation preserves shared storage.
- Source deletion blocks before cleanup and verifies all connector actions.
- Restriction flags memory and reports partial until review.
- Review acknowledgement keeps the artifact blocked.
- Erasure deletes memory despite default flag policy.
- Version updates invalidate old derivatives and permit new-root registration.
- False verification retries rather than marking deleted.
- Exhausted jobs dead-letter and can be explicitly requeued.
- Expired leases reclaimed; stale fencing tokens cannot commit.
- Concurrent workers avoid duplicate claims in the tested scenario.
- Concurrent job completions serialize the event aggregate refresh.
- Registration/deletion races leave no active post-delete registry derivative.
- Event idempotency and payload-conflict detection.
- Erasure priority over earlier updates.
- Migration checksum tamper detection.

## 3. Live connector qualification

Start Redis 6+ and a PostgreSQL instance with pgvector available. Use disposable test databases/keyspaces.

```bash
export REDIS_URL=redis://localhost:6379
export CONTEXTLINE_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/contextline_test
export CONTEXTLINE_TEST_PGVECTOR=1
npm run test:live
```

The Redis test creates a unique tenant-prefixed key, invalidates it, checks the exact tombstone and preserved TTL, deletes it, verifies absence, and repeats deletion. The pgvector test creates the extension/table if permitted, inserts a synthetic vector row through ordinary SQL, deletes it through the adapter, and verifies idempotence. It cleans up its row.

Without these variables, tests are explicitly skipped—not reported as passed. The default demo does not use Redis or pgvector.

## 4. CI

`.github/workflows/ci.yml` runs on pushes to `main`/`arena/**` and pull requests:

1. `npm ci`.
2. `npm run check`.
3. Live Redis/pgvector tests against service containers.
4. `npm audit --omit=dev --audit-level=high`.
5. Docker image build.

The workflow has been executed remotely: GitHub Actions run [42399911024](https://github.com/habtamugeta2-r/ContextLine/actions/runs/42399911024) passed build, example typecheck, blueprint gates, unit/PostgreSQL/smoke tests, live Redis/pgvector tests, production audit, and Docker image build. Local sandbox results and remaining gaps are recorded in [validation](validation.md).

## 5. Benchmark methodology

`scripts/benchmark.ts` creates a temporary PostgreSQL cluster, registers 1,000 artifacts with three roots each, warms up 20 requests, and measures 100 sequential requests of 20 candidates. The synthetic auth callback returns immediate allows. Timing includes registry lookup and durable audit writes; it excludes vector search, network auth latency, and LLM inference. It reports p50/p95/max and environment details.

This is a microbenchmark, not a production capacity test. Before claiming `<5ms p95`, test with realistic network distance, pool contention, auth-service latency, tenant skew, concurrent requests, source fan-out, audit volume, and failover. Also benchmark propagation throughput and queue aging under mass revocation.

## 6. Adding tests

Every security-relevant change should include a regression test that fails before the fix. Prefer real PostgreSQL tests for locking/RLS/transaction behavior; mocks cannot prove those properties. Connector changes need both contract fakes and live-service qualification. Document any skipped environment explicitly.

Do not convert a failing security assertion into a weaker expectation merely to make CI green. Determine whether the implementation or the stated invariant is wrong, then update both code and documentation deliberately.


## Chaos scenarios

`tests/chaos.test.ts` scripts the five blueprint stories against a real PostgreSQL cluster:

| Scenario | Fault injected | Expected outcome (asserted) |
|---|---|---|
| Lying storage | `delete` returns success but the row remains, once | Verification fails, the job retries, attempt 2 converges, history records `verified: false` |
| Mid-flight worker kill | A job is claimed and the worker never finishes | The lease expires, a second worker reclaims it, the dead worker's stale token cannot commit, exactly one completion is recorded |
| Auth blackout | The callback exceeds its timeout | Everything denied with `authorization_timeout`; explicit fail-open is recorded as `authorization_allow_override`; recovery restores service |
| Registry outage | A pool pointed at a closed port | `filterAuthorized` returns `[]` and `assertCanServe` returns false within the pool timeout, even with `onError: 'allow'` |
| Four-hop cascade | document → chunk → answer → summary → fact | Every hop flattens to the same root, so one erasure event finds and deletes all four derivatives |

## Blueprint gates

`npm run gates` fails the build if:

- the SDK's runtime dependency list is anything other than exactly `pg`;
- the shipped SDK output exceeds 50KB gzipped (currently 17.5KB, unminified — a conservative upper bound);
- any module outside `postgres.ts` and `connectors.ts` issues SQL;
- the registry store names a table outside the registry, or reaches a customer storage table;
- the worker touches storage other than through a connector.

`npm run typecheck:examples` compiles the five adoption examples against the real SDK so they cannot
drift from the API.

## Benchmark

`scripts/benchmark.ts` is configurable: `BENCH_ROWS`, `BENCH_TENANTS`, `BENCH_ITERATIONS`, `BENCH_CACHE`,
`BENCH_GATE`, `BENCH_OUT`. It reports lookup, end-to-end, and warm-cache distributions separately with
explicit pass/fail gates. `.github/workflows/benchmark.yml` runs it nightly and on demand at 1M rows.
See [validation](validation.md) for the recorded numbers and their limits.
