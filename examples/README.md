# Five adoption stages

Each file is a working, type-checked path into one capability. They compile against the
real SDK (`npm run typecheck:examples`), so they cannot drift from the API. Replace the
interfaces in [shared.ts](shared.ts) with your own vector store, cache, and permission
service — ContextLine never owns those systems.

| Stage | File | What it proves |
|---|---|---|
| 1. Ingestion | [01-ingestion-registration.ts](01-ingestion-registration.ts) | Register before writing; a mid-flight revocation skips the write instead of creating an orphan. |
| 2. Retrieval | [02-retrieval-filtering.ts](02-retrieval-filtering.ts) | One batched lookup, conjunctive authorization, ranking preserved, answers registered against **root** sources. |
| 3. Cache | [03-cache-revalidation.ts](03-cache-revalidation.ts) | A cache hit is a serving decision, so revocation is visible before any cleanup runs. |
| 4. Lifecycle | [04-lifecycle-events.ts](04-lifecycle-events.ts) | Webhook → correctly scoped event, idempotent by delivery ID. |
| 5. Memory | [05-memory-store.ts](05-memory-store.ts) | Opaque owner enables principal-scoped revocation; every recall re-checks. |

## Wiring

```ts
import { ContextLine, PostgresRegistry, createPool } from '@contextline/core';

const registry = new PostgresRegistry(createPool({
  connectionString: process.env.CONTEXTLINE_DATABASE_URL, // non-owner, NOBYPASSRLS
  max: 10,
  connectionTimeoutMillis: 200, // fail fast when the registry is unreachable
}));
const ctx = new ContextLine(registry); // fail-closed defaults, no auth cache
```

Adopt them in order. Stage 1 alone is safe: registering artifacts changes nothing about
serving until you turn on stage 2, and `unregisteredPolicy: 'quarantine'` lets you learn
what is missing before you switch to `deny`.

## Moving from quarantine to deny

```bash
contextline-migrate quarantine list --tenant acme
# assign root sources for what you found, then:
contextline-migrate quarantine backfill --tenant acme --file mappings.json
```

`mappings.json` is an array of `{artifactId, artifactVersion?, type, connectorId,
storageRef, ownerPrincipal?, sources:[{id,version}]}`. Backfill registers through the same
immutable, race-checked path as ingestion, then marks the manifest rows resolved.
