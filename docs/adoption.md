# Incremental adoption guide

ContextLine is useful before every store is instrumented, but coverage claims must match the paths actually governed. Do not turn on default deny across a large unregistered corpus without a rollout plan.

## Stage 0 — Inventory and threat model

List every place source-derived information can live:

- Chunk/embedding stores and their primary keys.
- Exact and semantic answer caches.
- Conversation summaries and persistent prompt memory.
- Agent facts, plans, tool outputs, and shared memory pools.
- Search indexes, exports, traces, and downstream application stores.
- Backups, replicas, and model training/fine-tuning pipelines.

For each store record: owner, tenant boundary, root-source mapping availability, serving paths, deletion API, verification semantics, retention, and whether ContextLine will govern it. Identify out-of-scope copies explicitly.

## Stage 1 — Instrument ingestion

Create source identities and register derivative metadata before publication.

```ts
await ctx.ensureSource(tenantId, { id: docId, version: 1 });
const artifacts = chunks.map((c, i) => ({
  id: `${docId}:chunk:${i}`, type: 'embedding' as const,
  connectorId: 'vectors', storageRef: c.id,
}));
await ctx.registerDerivation({ tenantId, sources: [{ id: docId, version: 1 }], artifacts });
await publishChunksWithSourceFence(chunks); // application-specific publication barrier
```

**Value:** forward/backward impact queries become possible. **Not yet protected:** retrieval paths that do not call the SDK.

Publication fencing matters: a source can be deleted after registration but before an external write. Use a transactional outbox, generation token, or pre-publish lifecycle recheck plus reconciliation. The SDK cannot atomically commit to an unrelated storage system.

## Stage 2 — Govern retrieval

Wrap vector candidates before prompt construction:

```ts
const run = await ctx.beginRun(tenantId, principal);
const authorized = await ctx.filterAuthorized({ run, candidates, authorize });
```

Start with `unregisteredPolicy: 'quarantine'` in a shadow/canary environment to build a manifest without serving unknown artifacts. Move to `deny` after backfill. `allow` is a temporary, explicitly approved rollout mode and must not be described as full enforcement.

**Value:** unauthorized chunks stop entering governed prompts. **Remaining gaps:** caches, memory, direct storage access, and uninstrumented applications.

Measure authorization latency, denial reasons, registry pool usage, and candidate fan-out. Keep pre-retrieval tenant filtering for efficiency; ContextLine is an additional boundary, not a reason to scan every tenant's vectors.

## Stage 3 — Govern caches

Register every generated answer against all contributing roots. Use tenant-aware cache keys. Before serving an exact or semantic hit:

```ts
if (!await ctx.assertCanServe({ tenantId, principal, artifact: cacheArtifactId, authorize })) {
  return regenerateFromAuthorizedRoots();
}
```

A mixed answer is denied as a whole if any root is unauthorized. Do not delete shared cache data solely because one principal is denied. For semantic caches, ensure the cached answer's provenance reflects its actual sources, not just the query used to find it.

**Value:** cache hits no longer bypass source authorization.

## Stage 4 — Connect lifecycle events

After authoritative ACL changes, record principal events. For source-wide deletion/restriction/update, record the corresponding source event and deploy the worker with verified connectors.

```ts
await acl.revoke(principal, sourceId);
await ctx.recordSourceEvent({
  tenantId, sourceId, event: 'permission_revoked',
  affectedPrincipals: [principal], idempotencyKey: changeRequestId,
});
```

Use a durable application outbox if the ACL change and event call cannot be atomic. Reconciliation must detect missed events. ContextLine does not poll your identity provider in v0.1.0.

**Value:** registered primary storage converges and produces audit evidence. **Remaining gaps:** backups, replicas, downstream copies, and unregistered stores.

## Stage 5 — Govern memory and agents

When a summary or fact is derived from an answer, inherit the answer's root sources:

```ts
await ctx.registerDerivation({
  tenantId, sources: [], derivedFrom: [{ id: answerArtifactId, version: 1 }],
  artifacts: [{ id: memoryId, type: 'memory', connectorId: 'memory', storageRef: `facts/${memoryId}` }],
});
```

Every memory read that can enter a prompt or agent plan must pass `assertCanServe` or `filterAuthorized`. Shared agent memory needs the same principal/tenant context as interactive retrieval. A fact created under one user's permissions must not become globally trusted merely because an agent stored it.

For source restriction, memory defaults to review-flagged and blocked. For erasure, configure a connector capable of actual deletion and run the deletion workflow. Human review is not a substitute for erasure.

## Backfill strategy

1. Export artifact IDs and trustworthy source mappings from the producing pipeline.
2. Reconcile duplicates, tenant boundaries, and current source versions.
3. Register in bounded batches (≤100 artifacts/roots per call).
4. Use exact retries safely; investigate immutable-field conflicts rather than overwriting.
5. Track quarantine decisions as a coverage metric.
6. Delete or keep blocked artifacts whose provenance cannot be established.

The default API rejects new artifacts bound to noncurrent or nonactive roots. Historical import is a separate privileged/reviewed workflow on the roadmap; do not bypass lifecycle checks by fabricating active sources.

## Coverage evidence

For each application, record:

- Number of retrieval/cache/memory serving paths and how many call the SDK.
- Registered artifacts by connector/type versus storage inventory counts.
- Unknown/quarantine decision rate over time.
- Root-source completeness checks from producer logs.
- Lifecycle event completion, verification, dead-letter, and review counts.
- Out-of-scope stores and compensating controls.

A useful internal objective is “100% of identified governed serving paths instrumented and 100% of served artifacts have verified root provenance,” not “all enterprise data is secure.”

## Rollback and removal

Do not roll back by silently allowing unknown artifacts. If the SDK/registry is removed, the application loses this enforcement layer. Keep a governed fallback or disable the affected AI feature. Preserve required audit evidence and lifecycle tombstones according to retention policy.


## Copy-paste paths

The five stages now have type-checked reference implementations in [../examples](../examples/README.md):
ingestion registration, retrieval filtering, cache revalidation, lifecycle events, and memory stores.
They compile against the real SDK in CI (`npm run typecheck:examples`), so the code you copy is the code
that is tested.

For estates with existing unregistered artifacts, the path is: deploy with
`unregisteredPolicy: 'quarantine'` → `contextline-migrate quarantine list` → assign root sources →
`quarantine backfill` → switch to `deny` once the open manifest is empty. See
[operations](operations.md).
