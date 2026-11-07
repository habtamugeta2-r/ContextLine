# Storage connectors

Connectors are the only components that mutate derivative storage. They are configured by operators and selected by an artifact's `connectorId`. Artifact type is descriptive and must not be used to infer an arbitrary table or endpoint.

## 1. Contract

```ts
interface ConnectorContext { tenantId: string }
interface StorageConnector {
  readonly type: string;
  delete(storageRef: string, context: ConnectorContext): Promise<void>;
  invalidate(storageRef: string, context: ConnectorContext): Promise<void>;
  verify(storageRef: string, context: ConnectorContext,
         expected: 'deleted' | 'invalidated'): Promise<boolean>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
}
```

Requirements:

- **Idempotent:** deleting an absent artifact succeeds; repeated invalidation converges.
- **Tenant-aware:** never mutate another tenant's record because of a crafted reference.
- **Verifiable:** success responses are insufficient; `verify` checks actual primary-store state.
- **Bounded:** the worker wraps delete/invalidate/verify in timeouts, but connectors should also configure client-level timeouts where possible.
- **Credential-safe:** do not embed secrets in storage references or throw secrets into logs.
- **Consistent enough to verify:** understand read-after-write, replica lag, and eventual consistency before declaring completion.

The worker calls delete/invalidate, then verify, then commits the registry result under a fencing token. A timeout can occur after the external side effect; retry must remain safe.

## 2. Generic PostgreSQL tables

```ts
import { PostgresTableConnector } from '@contextline/worker';
const memory = new PostgresTableConnector(pool, {
  summaries: {
    schema: 'public', table: 'conversation_summaries',
    idColumn: 'id', tenantColumn: 'tenant_id', statusColumn: 'status',
  },
  facts: {
    schema: 'public', table: 'agent_facts',
    idColumn: 'id', tenantColumn: 'tenant_id', statusColumn: 'status',
  },
});
```

Storage references are `configuredTableKey/rowId`, for example `summaries/summary-42`. The key selects an operator allowlist entry; the row ID is a parameter. SQL identifiers must match `^[a-z][a-z0-9_]{0,62}$`. Unknown keys and extra path segments are rejected.

- `delete`: `DELETE ... WHERE idColumn=$1 AND tenantColumn=$2`.
- `invalidate`: set the configured status column to `stale`, or to `pending_review` when the artifact type is `memory` (the worker passes `artifactType` in the context). Requires `statusColumn`.
- `verify(deleted)`: no matching tenant/ID row.
- `verify(invalidated)`: row absent, or status exactly `stale` / `pending_review`.
- `healthCheck`: bounded `SELECT 1 ... LIMIT 0` against configured tables.

The application must ensure its retrieval paths respect `stale` and `pending_review` or, preferably, pass every candidate through ContextLine regardless of storage status. The connector does not rewrite application queries.

## 3. pgvector

```ts
const vectors = new PgVectorConnector(pool, {
  schema: 'public', table: 'document_chunks',
  idColumn: 'id', tenantColumn: 'tenant_id',
});
// storageRef is the bare row ID: "chunk-42"
```

This adapter performs tenant-scoped row deletion and verification. It does not create the vector extension, choose an embedding model, build indexes, or perform similarity search. The operator provisions pgvector and the table. The table must have the configured ID and tenant columns.

For retrieval-side filtering, remember that approximate indexes can return fewer results after selective filters. pgvector 0.8.0 introduced iterative index scans; tune and test the actual index/query plan rather than assuming metadata filtering is complete or cheap. ContextLine's post-retrieval enforcement is a safety layer, not a replacement for efficient pre-retrieval tenant filtering.

The default local demo uses ordinary PostgreSQL text chunks, not pgvector. The adapter's SQL contract is unit-tested; live pgvector qualification is an explicit optional/CI test.

## 4. Redis

```ts
import { Redis } from 'ioredis';
import { RedisConnector } from '@contextline/worker';
const client = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000,
});
const answers = new RedisConnector(client); // tenant prefix required by default
// storageRef: "acme-corp:answer:9f3a"
```

Default isolation requires the key to start with the exact context tenant ID followed by `:`. This prevents a tenant A registration from naming tenant B's key. If you use a physically separate Redis client/store per tenant, you may explicitly set `requireTenantPrefix: false`; document that boundary and test it.

- `delete`: `DEL`, idempotent.
- `invalidate` **deletes the key by default** (blueprint A: Redis has no soft invalidation, and absence is the only provable state). Pass `{ invalidationMode: 'tombstone' }` to opt into the previous behavior: an atomic Lua script checks existence, then `SET ... KEEPTTL` with the reserved tombstone below. It does not resurrect a missing key or extend its lifetime.
- `verify(deleted)`: `GET` returns null.
- `verify(invalidated)`: null, or the exact tombstone when tombstone mode is explicitly enabled.

```json
{"contextline":{"invalidated":true,"version":1}}
```

Tombstone mode is a deliberate deviation from the blueprint, kept for customers who want a poison value rather than a miss. Use dedicated string-valued cache keys. Applying the tombstone to a hash/list/stream is unsupported and will fail rather than silently corrupting semantics. `KEEPTTL` requires Redis 6+. The application must treat the tombstone as a cache miss even if it bypasses ContextLine. TTL preservation is covered by the live test path.

Redis replicas, persistence, eviction, and failover can affect verification. Verify against the authoritative endpoint used for serving; do not assume a lagging replica proves deletion. A reused key after deletion is a new publication and needs a new artifact version/provenance.

## 5. Worker configuration

See [`connectors.example.json`](../connectors.example.json). Supported CLI types:

```json
{
  "connectors": [
    {"id":"vectors","type":"pgvector","table":"document_chunks","schema":"public"},
    {"id":"answers","type":"redis","requireTenantPrefix":true},
    {"id":"memory","type":"postgres","tables":{
      "summaries":{"table":"conversation_summaries","statusColumn":"status"}
    }}
  ]
}
```

Connector IDs must be unique lowercase names. PostgreSQL connectors use `DATABASE_URL`; Redis uses `REDIS_URL`. Do not put passwords in the JSON file. The example table names are placeholders; create/adapt them in your application schema.

Custom connectors are registered programmatically through `LifecycleWorker({ connectors })`. The CLI does not load arbitrary JavaScript from configuration.

## 6. Verification and failure codes

| Code | Meaning | Operator response |
|---|---|---|
| `CONNECTOR_NOT_CONFIGURED` | Artifact references an unknown connector ID | Fix registration/configuration; do not silently skip |
| `CONNECTOR_TIMEOUT` | Operation exceeded worker timeout | Check store health; idempotent retry follows |
| `VERIFICATION_FAILED` | Store still contains active data after action | Investigate consistency, permissions, wrong table/key, or deceptive success |
| `UNKNOWN_TABLE` | Reference names a table key outside the allowlist | Fix storage reference or configuration |
| `INVALID_STORAGE_REFERENCE` | Malformed path/key | Fix producer instrumentation |
| `TENANT_PREFIX_REQUIRED` | Redis key does not match tenant boundary | Fix key naming; do not disable isolation casually |
| `INVALIDATION_NOT_SUPPORTED` | A connector cannot invalidate (pgvector without a status column falls back to deletion instead) | Configure a status column or use deletion |
| `INVALID_CONNECTOR_CONFIGURATION` | Unknown connector option, e.g. an unsupported Redis invalidation mode | Fix the configuration |
| `CONNECTOR_ERROR` | Other connector failure, sanitized | Inspect private service logs; retry/dead-letter workflow applies |

## 7. Adding a connector

1. Define the storage identity and tenant boundary.
2. Implement idempotent delete/invalidate and truthful verification.
3. Add contract tests with a fake client and live-service tests where possible.
4. Test wrong tenant, missing record, timeout after side effect, false success, replica lag, and key reuse.
5. Document required permissions, consistency, TTL/retention behavior, and failure modes.
6. Register it in the worker and instrument producers with the exact connector ID/reference format.

Pinecone, Qdrant, Weaviate, Milvus, Chroma, object stores, MongoDB, DynamoDB, and search indexes are roadmap adapters, not shipped implementations. Do not claim coverage merely because the interface could support them.


## Storage reference forms

The canonical form is `connector:target:record`, parsed by `parseStorageRef` in the core package:

| Form | Example | Notes |
|---|---|---|
| Canonical | `pgvector:chunks:chunk-42` | Connector kind must match the connector instance |
| Canonical, Redis | `redis:answers:acme:answer:9f3a` | The record ID keeps its colons; the tenant prefix is still required |
| Legacy target/record | `demo-chunks/chunk-42` | Still accepted; unchanged registrations keep working |
| Bare record | `chunk-42` | pgvector single-table convenience |
| Legacy Redis key | `acme:answer:9f3a` | Tenant-prefix check still applies |

Only the first two separators are structural, so record IDs may contain colons. Control characters,
empty segments, and references over 1024 characters are rejected before any database call.

## Invalidation fallbacks

- **pgvector without a status column:** `invalidate` performs a delete and `verify` checks absence. The
  registry still records the artifact as `stale`, so operators can see the intended action; the physical
  row is gone. Configure a status column if you need soft invalidation.
- **Agent memory in a generic table:** invalidation writes `pending_review`, not `stale`, because memory
  may hold synthesized multi-source knowledge that needs a human decision.
