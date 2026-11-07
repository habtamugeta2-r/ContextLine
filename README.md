# ContextLine

**The source-aware access control layer for AI-generated data.**

When a document is chunked, embedded, cached, summarized, or remembered by an agent, its permission boundary must survive those transformations. ContextLine connects derivative artifacts to their root sources, checks the caller's current authorization before retrieval, and propagates source lifecycle changes through a durable, verified worker.

> **Status: working local reference implementation, v0.2.0.** The SDK, PostgreSQL registry, lifecycle worker, connector adapters, interactive demo, and automated tests are implemented. A hosted control plane, enterprise SSO, managed operations, and production scale/latency guarantees are not. Read the [security model](docs/security.md) and [validation results](docs/validation.md) before evaluating it for production.

## Run it

Requirements: **Node.js 22+**, npm, and **Linux x64** for the bundled local-demo PostgreSQL binaries. The core SDK and worker are ordinary Node.js packages; no LLM API key is needed.

```bash
npm ci
npm run demo
```

Open **http://localhost:3000**. In Arena Agent Mode, use the live preview labeled **ContextLine interactive demo**.

Try this sequence:

1. Ask **“What were the Q3 revenue projections?”** as Alice. The cached synthetic answer is returned after source revalidation.
2. Click **Revoke selected principal's access**, then ask again. Alice receives no revenue context.
3. Inspect the registry: shared artifacts still exist because other principals may remain authorized.
4. Pause the worker and click **Delete + propagate**. Retrieval is blocked immediately, even before physical cleanup.
5. Process the queue. The 18 revenue-derived artifacts are deleted and verified; the two handbook chunks remain.
6. Switch to **Other Corporation**. The same source identifier resolves to different, isolated tenant data.

The demo uses synthetic facts, deterministic retrieval, and separate PostgreSQL tables. It does **not** call an LLM or pretend that its identity selector is authentication. Redis and pgvector adapters ship separately and have explicit live-service test paths.

## What is implemented

| Capability | Implementation |
|---|---|
| Dependency registry | Versioned root-source edges; multi-source artifacts; flattened transitive registration; idempotent, immutable artifact identity/provenance |
| Access enforcement | **One-round-trip** batched lookup; customer authorization callback; all-root AND semantics; unknown-provenance deny/quarantine with a buffered manifest; timeout and error policies; durable access decisions; opt-in allow-only cache |
| Lifecycle propagation | Transactional event outbox; principal-scoped vs source-wide blast radius; `SKIP LOCKED` claims; expiring leases, heartbeats, and fencing tokens; jittered retries; non-retryable dead letters; human-review state; connector verification |
| Tenant isolation | Tenant-inclusive keys and foreign keys; forced PostgreSQL RLS; least-privilege runtime grants; tenant-prefixed Redis keys by default |
| Storage adapters | Generic PostgreSQL tables (memory → review), pgvector delete with invalidation fallback, Redis delete-by-default; canonical `connector:target:record` parser; programmable custom connector interface |
| Developer experience | TypeScript packages, migration CLI, worker CLI, interactive dashboard, terminal demo, Docker/Compose files, CI, tests, and detailed documentation |

The core runtime has one direct dependency: `pg`. The worker adds `ioredis`. The dashboard uses browser-native JavaScript and CSS. Three CI gates protect those promises: the SDK dependency list must be exactly `pg`, the shipped SDK must stay under 50KB gzipped (currently 17.5KB), and no code outside the registry store and connectors may issue SQL.

### Measured, not promised

At **1,000,000 dependency rows across 50 tenants**, 10 candidates per request, 10,000 measured calls per phase, on a shared 2-vCPU sandbox:

| Phase | p95 | Blueprint gate |
|---|---|---|
| Backward lookup (one round-trip) | **1.16ms** | <2.0ms — met |
| `filterAuthorized` incl. durable audit | **3.18ms** | <5.0ms — met |
| Warm allow cache | 3.50ms | <2.5ms — **not met** |

The warm-cache gate is missed because the synthetic callback costs nothing, so caching removes no work while the durable audit write remains. These are local synthetic measurements, not a production SLA: see [validation](docs/validation.md) and the [full report](docs/benchmark-1m.json).

## Blueprint conformance

The engineering blueprint supplied for this project is recorded verbatim in [docs/blueprint/](docs/blueprint/README.md). Where its three passes disagree, [docs/blueprint-conflicts.md](docs/blueprint-conflicts.md) records the chosen behavior and why; [docs/conformance.md](docs/conformance.md) tracks all 96 requirements with evidence (80 met, 10 partial, 4 deliberate deviations, 1 deferred, 1 not met). Five copy-paste adoption paths live in [examples/](examples/README.md) and are type-checked in CI.

## Three capabilities, one boundary

```text
Source document + customer authorization system
                 │
                 ▼
       ┌──────────────────────┐
       │  Dependency registry │  source/version ↔ artifact/version
       └──────────┬───────────┘
                  │
       ┌──────────┴───────────┐
       ▼                      ▼
Real-time enforcement   Lifecycle worker
Before prompt/cache     Durable jobs → storage connectors
serving; fail closed    → verification → audit
```

**Enforcement makes retrieval safe under the documented integration contract. Propagation makes registered storage converge.** Cleanup success is not a prerequisite for denying a revoked principal. Conversely, a principal-specific revocation is not treated as permission to delete everyone else's data.

## Repository map

```text
packages/core/       SDK, PostgreSQL registry, migrations, migration CLI
packages/worker/     Worker, PostgreSQL/pgvector/Redis connectors, worker CLI
apps/demo/           Interactive dashboard, HTTP API, local PostgreSQL, CLI demo
tests/               Unit, real-PostgreSQL integration, optional live connectors
scripts/             HTTP smoke test and reproducible microbenchmark
docs/                Engineering, security, research, operations, product record
deploy/              Least-privilege runtime-role provisioning
.github/workflows/   Build, tests, live adapters, audit, container build
```

## Verify the build

```bash
npm run build       # TypeScript + migration/dashboard assets
npm run test:unit   # SDK policy and connector contract tests
npm run test:postgres # real temporary PostgreSQL 17 cluster
npm run smoke       # real HTTP/dashboard/API workflow
npm run check       # all of the above
npm run demo:cli    # isolated terminal walkthrough
npm run benchmark   # local synthetic latency measurement
```

Optional Redis/pgvector qualification requires running services:

```bash
REDIS_URL=redis://localhost:6379 \
CONTEXTLINE_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/contextline_test \
CONTEXTLINE_TEST_PGVECTOR=1 npm run test:live
```

See [testing](docs/testing.md) for exactly what each suite covers and [validation](docs/validation.md) for results actually observed in this checkout.

## Integrate the SDK

```ts
import { ContextLine, createPool, PostgresRegistry } from '@contextline/core';

const pool = createPool({ connectionString: process.env.DATABASE_URL });
const ctx = new ContextLine(new PostgresRegistry(pool));
const run = await ctx.beginRun('acme-corp', 'user:alice');

const authorized = await ctx.filterAuthorized({
  run,
  candidates: retrievedChunks.map(c => ({ artifactId: c.id, content: c.text })),
  authorize: async ({ tenantId, principal, sources }) => {
    // Replace with your authoritative batch authorization service.
    return yourAuthService.canReadSources({ tenantId, principal, sourceIds: sources.map(s => s.id) });
  },
  unregisteredPolicy: 'deny',
  onError: 'deny',
  timeoutMs: 500,
});
// Only authorized[].artifact.content may enter the prompt.
```

Register sources and derivatives at creation time, revalidate cached answers before serving them, and record source events after authoritative permission changes. Complete, compilable integration patterns are in the [API reference](docs/api.md) and [adoption guide](docs/adoption.md). Packages are workspace-local in this release; they have not been published to npm.

## Documentation

Start with the [documentation index](docs/README.md). Key references:

- [Quickstart](docs/quickstart.md) · [Interactive demo guide](docs/demo.md)
- [Architecture](docs/architecture.md) · [Schema](docs/schema.md) · [API](docs/api.md)
- [Security model](docs/security.md) · [Threat model](docs/threat-model.md)
- [Connectors](docs/connectors.md) · [Deployment](docs/deployment.md) · [Operations](docs/operations.md)
- [Research and evidence ledger](docs/research.md) · [Product strategy](docs/product-strategy.md)
- [Requirements coverage](docs/requirements.md) · [Decisions](docs/decisions.md) · [Roadmap](docs/roadmap.md)

## Important corrections to the original thesis

The supplied brief is a product hypothesis, not a set of established facts. OWASP documents permission and embedding risks, but that does not prove access control is the single largest AI-adoption blocker. Existing authorization and permission-aware RAG systems already cover parts of this space. ContextLine's proposed differentiation is **cross-store root provenance plus enforcement plus verified lifecycle propagation**, not a claim that nobody has addressed AI authorization. See the [research ledger](docs/research.md).

A metadata-only registry is **not automatically outside GDPR**. Source IDs, storage references, tenant IDs, and principal IDs can be personal or commercially sensitive data. Article 17 has grounds and exceptions; this software supplies technical evidence, not legal compliance. See [security](docs/security.md) and [operations](docs/operations.md).

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [third-party notices](docs/third-party.md).
