# Interactive demo guide

The dashboard is a local, synthetic demonstration of the real SDK/registry/worker. It is not a mock API: queries write access decisions, lifecycle actions create durable events/jobs, and connectors mutate separate PostgreSQL tables.

## Data model

Acme starts with:

- 12 revenue retrieval chunks (embedding stand-ins).
- 3 cached answers, each derived from revenue + handbook.
- 1 conversation summary derived from revenue.
- 2 agent facts derived through the summary's root revenue source.
- 2 handbook chunks.

Thus the registry shows **20 artifacts**, of which **18 depend on the revenue source**. Other Corporation starts with 2 revenue chunks and 1 handbook chunk under the same source IDs but a different tenant boundary. All figures are synthetic.

The demo stores content in `demo_chunks`, `demo_cache`, `demo_summaries`, and `demo_memories`. The core registry stores only metadata. Retrieval is deterministic keyword selection, not vector similarity or an LLM. The cache is a PostgreSQL table, not Redis; the shipped Redis adapter is tested separately.

## Controls

| Control | What actually happens |
|---|---|
| Tenant selector | Switches the server-side demo tenant scope; not authentication |
| Request identity | Selects Alice or Bob as the simulated trusted principal |
| Ask assistant | Creates a run, revalidates a cache hit or filters retrieval/memory candidates, writes decisions |
| Revalidate cached answers | Enables the cache-hit path; disabling it exercises retrieval |
| Revoke selected principal | Removes the authoritative demo ACL grant, records an audit-only principal event |
| Restore selected principal | Restores the demo ACL grant and records an audit-only event; does not resurrect artifacts |
| Delete + propagate | Marks the source deleted and queues verified deletion jobs |
| Restrict source | Marks it revoked; invalidates non-memory derivatives and flags memory for review |
| Publish new version | Creates the next source version and invalidates old-version derivatives; does not ingest new content |
| GDPR-style erasure | Records an erasure event and queues deletion of all known derivatives, including memory |
| Undo source-wide lifecycle status | Reactivates the source; stale/flagged/deleted artifacts remain blocked |
| Pause/resume worker | Stops/starts background processing; retrieval enforcement remains active |
| Process once | Runs one bounded worker pass, even while paused |
| Simulate storage outage | Connector mutations throw a sanitized failure; retries/dead letters become visible |
| Retry dead-letter jobs | Explicitly requeues exhausted failed jobs |
| Acknowledge review | Completes the review workflow while keeping the memory artifact blocked |
| Reset demo | Privileged synthetic-data reset for the selected tenant, with worker paused |

## Suggested walkthroughs

### Principal revocation without over-deletion

Ask as Alice → revoke Alice → ask again → inspect registry. Revenue artifacts remain because Bob or another principal may still be authorized. Alice's decisions are denied. Ask about the handbook to see authorized content still available.

### Enforcement while cleanup is delayed

Pause worker → delete source → ask again. Content is blocked from the registry state before storage cleanup. Process once/resume → inspect verified jobs and reduced storage counts.

### Partial propagation and review

Restrict source → expand the event. Non-memory jobs are invalidated; memory jobs are `pending_review`, so the event is partial. Ask for revenue: blocked. Acknowledge review to close the workflow while keeping the artifact blocked, or issue erasure to delete it.

### Storage failure

Enable outage → delete/restrict a source → inspect retry attempts and error codes. Restore storage and let backoff elapse, or requeue after exhaustion. Retrieval remains blocked throughout. Demo backoff is accelerated (500ms–8s) for interaction; production defaults are longer.

### Tenant isolation

Delete Acme's revenue source → switch to Other Corporation → ask as its authorized Alice. The other tenant's synthetic figure remains available. Identical source IDs do not create cross-tenant edges.

## API surface (demo only)

- `GET /api/health`
- `GET /api/snapshot?tenant=acme-corp|other-corp`
- `GET /api/metrics`
- `POST /api/query` with `{ tenant, principal, question, useCache }`
- `POST /api/action` with an allowlisted `{ tenant, action, ... }`
- `GET /docs/<name>.md` for repository documentation as plain Markdown

Mutations require JSON and reject browser cross-site origins. There are no CORS headers. These checks reduce casual cross-site abuse but do not authenticate callers; never deploy the demo with real data.

## Visual design

The interface uses a responsive dark navigation rail, a restrained teal/slate palette, capability cards, a live retrieval lab, source lifecycle controls, registry filtering, expandable event/job evidence, and an access audit table. It uses system fonts and local SVG icons—no external font/image CDN or frontend framework.
