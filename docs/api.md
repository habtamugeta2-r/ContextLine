# SDK and API reference

Package: `@contextline/core` · Node.js 22+ · ESM · TypeScript declarations included after build. The package is workspace-local, not published to npm.

## 1. Construction and migrations

```ts
import { ContextLine, PostgresRegistry, createPool, migrateRegistry } from '@contextline/core';

// Migration connection: schema owner. Run once in deployment tooling.
const ownerPool = createPool({ connectionString: process.env.CONTEXTLINE_MIGRATION_DATABASE_URL });
await migrateRegistry(ownerPool, { schema: 'contextline' });
await ownerPool.end();

// Runtime connection: dedicated NOSUPERUSER NOBYPASSRLS role.
const pool = createPool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const registry = new PostgresRegistry(pool, { schema: 'contextline' });
const ctx = new ContextLine(registry, {
  auditPolicy: 'required',
  onDiagnostic: d => logger.warn(d), // { code, operation, tenantId }; no content
});
```

`createPool` is a thin wrapper around `pg.Pool`. You may pass an existing compatible pool. Close it during graceful shutdown. Do not share a pool across trust domains with different PostgreSQL privileges.

## 2. Source registration

```ts
await ctx.ensureSource('acme-corp', { id: 'doc:q3-revenue', version: 1 });
```

A new source starts at version 1. Repeating the exact existing source/version is a no-op. To create later versions, use `recordSourceEvent({ event: 'document_updated', newVersion: current + 1 })`. Do not call `ensureSource` with an arbitrary later version for a new source.

Source IDs are customer-defined opaque identifiers. Do not embed document text, email addresses, or secrets unless your privacy review explicitly permits that metadata.

## 3. Derivative registration

```ts
await ctx.registerDerivation({
  tenantId: 'acme-corp',
  sources: [{ id: 'doc:q3-revenue', version: 1 }],
  artifacts: chunks.map((chunk, i) => ({
    id: `embedding:q3:chunk-${i}`,
    version: 1,
    type: 'embedding',
    connectorId: 'vectors',
    storageRef: chunk.id, // pgvector adapter: bare row ID
  })),
});
```

Artifact types: `embedding | cache | summary | memory | other`. Type is descriptive; **connector ID**, not type alone, routes lifecycle work. Connector IDs must match the worker's operator-controlled configuration.

Registration rules:

- Sources must already exist.
- New artifacts must reference active, current root versions.
- Exact retries are no-ops, including retries after a source/artifact was deleted.
- Type, connector ID, storage reference, and root set are immutable for an artifact version.
- A deleted artifact version cannot be resurrected.
- One version per root source is allowed in a registration.
- Up to 100 artifacts and 100 resolved roots per call.

### Multi-source answers

```ts
await ctx.registerDerivation({
  tenantId: 'acme-corp',
  sources: [
    { id: 'doc:q3-revenue', version: 1 },
    { id: 'doc:handbook', version: 1 },
  ],
  artifacts: [{
    id: 'acme:answer:9f3a',
    type: 'cache',
    connectorId: 'answers',
    storageRef: 'acme:answer:9f3a', // Redis adapter requires tenant prefix
  }],
});
```

Every root must authorize before the answer is served. If one root is revoked for a principal, the whole mixed answer is denied to that principal. Do not try to “partially serve” a synthesized answer without regenerating it from authorized inputs.

### Transitive derivatives

```ts
await ctx.registerDerivation({
  tenantId: 'acme-corp',
  sources: [], // roots are inherited from the registered parent
  derivedFrom: [{ id: 'acme:answer:9f3a', version: 1 }],
  artifacts: [{
    id: 'memory:conversation:42',
    type: 'memory',
    connectorId: 'memory',
    storageRef: 'summaries/memory:conversation:42',
  }],
});
```

The registry resolves the parent's root sources and stores them on the child. Unknown parents and conflicting root versions are rejected. Self-derivation is rejected. This flattens the access-control graph; it is not a full lineage visualization API.

## 4. Retrieval enforcement

```ts
const run = await ctx.beginRun('acme-corp', 'user:alice');
const authorized = await ctx.filterAuthorized({
  run,
  candidates: retrieved.map(c => ({ artifactId: c.id, artifactVersion: 1, content: c.text })),
  authorize: async ({ tenantId, principal, sources }) => {
    // Must return exactly one boolean for every requested source ID.
    return yourAuthService.canReadSources({
      tenantId, principal, sourceIds: sources.map(s => s.id),
    });
  },
  unregisteredPolicy: 'deny',
  onError: 'deny',
  timeoutMs: 500,
});

for (const item of authorized) {
  // item.artifact is the original candidate; item.sourceRefs are resolved roots.
  promptContext.push(item.artifact.content);
}
```

The callback is invoked once per enforcement call with deduplicated source IDs. It may return a `Map<string, boolean>` or `Record<string, boolean>`. Authorization is checked against the current source ID; version freshness is checked separately.

| Option | Default | Meaning |
|---|---|---|
| `run` | Required | Server-created `{ id, tenantId, principal }`; never accept a client-supplied run identity as trusted |
| `candidates` | Required | Unique artifact IDs/versions plus arbitrary application payload; 0–100 items |
| `authorize` | Required | Strict batched callback for all eligible unique roots |
| `unregisteredPolicy` | `deny` | `deny`, `quarantine`, or explicit rollout `allow` |
| `onError` | `deny` | Auth error behavior: `deny`, `skip`, or explicit debug `allow` |
| `timeoutMs` | `500` | Whole callback batch timeout, 1–30,000 ms |
| `allowOutdatedVersions` | `false` | Freshness override only; never overrides deleted/revoked/expired roots |

Returns `Array<{ artifact: T; sourceRefs: SourceRef[] }>` in candidate order. Registry failure returns an empty array and emits a diagnostic. Invalid inputs throw. Required audit failure returns an empty array. An `allowed` audit decision describes authorization, not proof that the application ultimately delivered a model response.

## 5. Cache and memory serving

```ts
const canServe = await ctx.assertCanServe({
  tenantId: 'acme-corp',
  principal: 'user:alice',
  artifact: { id: 'acme:answer:9f3a', version: 1 },
  authorize: async ({ sources }) => yourAuthService.canReadSources({
    tenantId: 'acme-corp', principal: 'user:alice', sourceIds: sources.map(s => s.id),
  }),
});
if (!canServe) return regenerateFromAuthorizedContext();
return cachedAnswer;
```

A string artifact ID is accepted and defaults to version 1. An optional `run` must match the supplied tenant and principal; mismatch throws. Without a run, one is created. Do not delete a shared cache entry merely because one principal is denied; other principals may still be authorized.

For semantic caches, register the provenance of the actual generated answer and all sources that contributed to it. A similarity match to another query does not prove equivalent authorization.

## 6. Source lifecycle events

```ts
// After authoritative ACL revocation for Alice only:
await ctx.recordSourceEvent({
  tenantId: 'acme-corp',
  sourceId: 'doc:q3-revenue',
  event: 'permission_revoked',
  affectedPrincipals: ['user:alice'],
  idempotencyKey: 'offboarding:alice:q3:2026-11-07',
});

// Source-wide deletion, not a principal-specific revocation:
const event = await ctx.recordSourceEvent({
  tenantId: 'acme-corp',
  sourceId: 'doc:q3-revenue',
  event: 'document_deleted',
  idempotencyKey: 'deletion:q3:request-123',
});
```

Supported events and effects are listed in [architecture](architecture.md). Principal events require a nonempty principal list and do not delete shared storage. `source_restricted`/`source_reactivated` are explicit source-wide controls. `document_updated` requires exactly the next version.

`memoryAction` applies to `source_restricted`, `retention_expired`, and `permission_revoked`: `flag` (default), `invalidate`, or `delete`. Erasure and deletion events always delete memory regardless of this setting.

Idempotency keys are tenant-scoped. Reusing a key with the same canonical payload returns the existing event; changing the payload throws `IDEMPOTENCY_CONFLICT`. Without a key, each call records a new audit event even if connector actions are idempotent.

The method returns a `LifecycleEventRecord`. Async cleanup is not complete when this method returns. Inspect the event and its jobs through `PostgresRegistry.getEvent/listEvents/listJobs` or your own trusted administrative interface.

## 7. Administrative registry methods

`PostgresRegistry` additionally exposes:

- `healthCheck()`, `transaction(tenantId, fn)` for trusted extension code.
- `listSources`, `listArtifacts`, `listEvents`, `listJobs`, `listDecisions`, `queueStats` for tenant-scoped views. Lists are bounded (200 decisions, 1,000 artifacts/jobs, up to 100 events); they are not bulk export APIs.
- `retryEvent(tenantId, eventId)` requeues only exhausted `failed` jobs and resets their attempt budget. It does not retry future-scheduled retries or silently approve review jobs.
- `acknowledgeReview(tenantId, jobId, reviewer)` closes a `pending_review` flag job while leaving the artifact blocked. It is idempotent and records the reviewer in job history. If deletion is required, issue the appropriate source deletion/erasure event.
- `materializeNextEvent`, `claimJobs`, `finishJob` are worker-facing primitives. Application code should normally use `LifecycleWorker`.
- `metricsText` formats worker counters; `queueStats` supplies tenant-scoped queue gauges.

Do not expose these methods directly to unauthenticated users. Build an authorized administrative layer appropriate to your deployment.

## 8. Worker API

```ts
import { LifecycleWorker, PgVectorConnector, RedisConnector } from '@contextline/worker';
const worker = new LifecycleWorker({
  registry,
  tenants: ['acme-corp'],
  connectors: {
    vectors: new PgVectorConnector(pool, { table: 'document_chunks' }),
    answers: new RedisConnector(redisClient),
  },
  batchSize: 20,
  concurrency: 4,
  leaseMs: 60000,
  operationTimeoutMs: 10000,
  maxAttempts: 6,
  retryDelaysMs: [1000, 5000, 30000, 300000, 1800000],
});
worker.start();
// later: await worker.stop();
```

`tick()` performs one bounded pass and returns completed job count. `pass()` also reports materialized events and claims. `drain(tenant, maxJobs)` is a bounded test/maintenance helper, not an unbounded production loop. `metrics()` returns Prometheus text. See [connectors](connectors.md) and [operations](operations.md).

## 9. Errors and limits

`ContextLineError` has a stable `code` and a sanitized message. Common codes:

| Code | Cause |
|---|---|
| `INVALID_IDENTIFIER`, `INVALID_VERSION`, `INVALID_BATCH` | Invalid or oversized API input |
| `DUPLICATE_ARTIFACT`, `DUPLICATE_CANDIDATE` | Duplicate version in one batch |
| `UNKNOWN_SOURCE`, `UNKNOWN_PARENT` | Missing provenance prerequisite |
| `IMMUTABLE_ARTIFACT`, `IMMUTABLE_PROVENANCE` | Attempt to rewrite a committed artifact version |
| `SOURCE_UNAVAILABLE` | New artifact references a nonactive/noncurrent root |
| `TENANT_MISMATCH`, `INVALID_RUN` | Run identity does not match the operation |
| `IDEMPOTENCY_CONFLICT` | Key reused with different event payload |
| `INVALID_TIMEOUT`, `INVALID_POLICY`, `AUTH_RESULT` | Invalid enforcement configuration/result |
| `MIGRATION_CHANGED` | Applied migration checksum changed |
| `UNSAFE_ROLE` | Runtime role is privileged or owns the tables |

Connector errors use `ConnectorError` codes such as `CONNECTOR_NOT_CONFIGURED`, `CONNECTOR_TIMEOUT`, `VERIFICATION_FAILED`, `UNKNOWN_TABLE`, and `TENANT_PREFIX_REQUIRED`. Raw connector errors are not written to job history.

IDs are limited to 512 characters, storage references to 1,024, connector IDs to 64, and principal lists to 100. Schema names are restricted to lowercase SQL identifiers. These are safety bounds, not performance guarantees.


## Blueprint conformance additions (0.2.0)

### `ContextLineOptions`

| Option | Default | Meaning |
|---|---|---|
| `auditPolicy` | `'required'` | An unauditable allow decision is blocked |
| `authCache` | disabled | `{ enabled, ttlMs, maxEntries }`. Allow-only; `ttlMs` is hard-capped at 30000 and validated at construction |
| `quarantineFlush` | `{ intervalMs: 5000, maxItems: 100 }` | Background manifest flush; never on the request path |

### `EnforcementOptions.authorizeMode`

`'batch'` (default) sends every unique root in one callback invocation. `'per-source'` implements the
blueprint literally: one timed call per unique source, in parallel. Both deduplicate by source ID,
enforce the same timeout, and require every root to authorize.

### New methods

| Method | Behavior |
|---|---|
| `ctx.flushQuarantine()` | Flush the buffered manifest hits now; resolves when the write settles |
| `ctx.close()` | Stop the flush timer, flush the buffer, clear the auth cache. The caller still owns the pool |
| `registry.recordQuarantineHits(tenantId, hits)` | Bulk upsert with occurrence counting |
| `registry.listQuarantine(tenantId, includeResolved?)` | Manifest rows for backfill |
| `registry.resolveQuarantine(tenantId, refs)` | Mark rows resolved; does not change the artifact |
| `registry.heartbeatJob(job, leaseMs)` | Extend a live lease; returns false for a stale token |

### Registration additions

- `createSources?: boolean` — bulk-insert missing **version-1** sources in the same transaction. It can
  never reactivate a revoked, deleted, or expired source.
- `ArtifactRegistration.ownerPrincipal?: string` — opaque owner. Required for principal-scoped cleanup
  of personal cache/memory artifacts.
- Artifact batches are capped at **500** (previously 100); root sources remain capped at 100.

### Cache staleness bound

With `authCache` enabled, an allow decision may be reused for up to `ttlMs` (≤30s) **within one process**.
`recordSourceEvent` purges that source locally; other processes converge at the TTL. Registry lifecycle
state is always read fresh, so a cached allow can never override a revoked, deleted, expired, or outdated
source. Denials are never cached.

### Error codes added

`SOURCE_UNAVAILABLE`, `CONCURRENT_REGISTRATION`, `INVALID_CONFIG`, `INVALID_STORAGE_REFERENCE`,
`INVALID_CONNECTOR_CONFIGURATION`. `QUARANTINE_FLUSH_FAILED` is emitted as a diagnostic, never thrown
into the request path.
