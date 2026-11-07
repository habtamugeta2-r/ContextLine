# Architecture

## 1. Product boundary

ContextLine is an application-infrastructure layer between authoritative source permissions and heterogeneous AI derivative stores. It does not replace identity, evaluate a new policy language, inspect content, or run model inference.

The implementation has three runtime components:

1. **Core SDK (`@contextline/core`)**: registration, retrieval enforcement, source events, and audit writes.
2. **PostgreSQL registry**: seven tenant-scoped tables plus a migration ledger. Four tables carry the domain model; three add durable per-artifact jobs and access audit.
3. **Worker (`@contextline/worker`)**: claims lifecycle jobs, invokes configured storage connectors, verifies outcomes, and records progress.

The interactive dashboard is a separate demonstration application. A hosted control plane is described in the product strategy but is **not implemented**. No configuration or data is sent to a ContextLine SaaS service.

## 2. Trust and data boundaries

```text
┌──────────────────── CUSTOMER TRUST DOMAIN ────────────────────┐
│                                                               │
│  User identity / session                                      │
│          │ trusted principal + tenant                         │
│          ▼                                                    │
│  AI application ───────────────► Authoritative auth service   │
│          │        batched source checks                       │
│          │                                                    │
│          ├─► ContextLine SDK ─► PostgreSQL registry            │
│          │                       metadata only                │
│          │                                                    │
│          ├─► Vector store / cache / summaries / agent memory   │
│          │       content stays here                           │
│          │                                                    │
│  Lifecycle worker ─► registry outbox ─► storage connectors     │
│          │                                                    │
│  Customer observability ◄─ metrics / diagnostics              │
└───────────────────────────────────────────────────────────────┘
```

The SDK trusts the application to supply an authenticated principal and the correct tenant. RLS protects registry rows even if a query forgets a tenant predicate, but it cannot authenticate an end user or prevent a compromised application from lying about identity. The authorization callback must remain authoritative for the supplied principal.

The registry receives identifiers, versions, connector IDs, storage references, lifecycle metadata, and access decisions. It does not receive chunk text, prompts, answers, or embedding arrays. **Identifiers themselves may be sensitive or personal.**

## 3. Capability 1: dependency registration

### Root-source model

A source is an external document identity plus a version. An artifact is a versioned derivative identity plus a connector/storage reference. Dependencies map artifact versions to **root source versions**.

```text
source A v1 ─┬─► embedding a1 v1
             ├─► embedding a2 v1
             └─► cached answer B v1 ─► summary C v1 ─► agent fact D v1
                   root(A v1)             root(A v1)       root(A v1)
```

The application may pass explicit root sources or `derivedFrom` parent artifact references. The SDK/registry resolves parents' registered roots and stores the flattened union. Intermediate lineage visualization is not stored as a graph. Conflicting versions of the same root are rejected.

Registration is transactional and idempotent for the exact same artifact identity, storage location, type, and roots. Changing roots or location requires a new artifact version/identity. Deleted artifact versions are tombstones and cannot be resurrected by retrying registration.

### Publication contract

Register provenance before publishing content, and fence the actual storage write against source deletion/update. A metadata registry cannot make a write to an unrelated external store atomic. If a process crashes between registration and publication, the result is an orphan metadata record; if it publishes without registration, default enforcement denies the artifact, but direct storage access remains outside ContextLine's boundary.

A same-database application can use a transactional outbox or shared transaction. Cross-system pipelines need a publish barrier, generation token, or reconciliation job. See [threat model](threat-model.md) and [adoption](adoption.md).

## 4. Capability 2: retrieval enforcement

```text
beginRun(tenant, principal)
        │
candidate artifact IDs (content remains in application memory)
        │
one batched backward registry lookup
        │
artifact status + root lifecycle + version checks
        │
deduplicate root IDs across all candidates
        │
one customer authorization callback for the unique roots
        │
strict boolean result validation; all roots must allow
        │
durable access decisions (required by default)
        │
return only authorized candidates, preserving input order
```

The callback receives `{ tenantId, principal, sources }` and returns a `Map<string, boolean>` or plain object with exactly one boolean per requested source ID. Authorization is for the **current source identity**; stored versions govern freshness, not permission lookup. Missing, extra, nonboolean, thrown, or timed-out results are errors.

Default behavior:

- Unknown provenance: deny.
- Empty provenance on a registered artifact: deny.
- Deleted/stale/pending-review artifact: deny.
- Deleted/revoked/expired root: deny, even if the callback says allow.
- Outdated root version: deny unless explicitly configured otherwise.
- Authorization error/timeout: deny.
- Registry lookup failure: deny all candidates.
- Audit write failure: deny the response under the default required-audit policy.

`assertCanServe` applies the same path to one cached answer or memory entry. A query-hash cache hit is never an authorization decision. Semantic-cache hits must carry the provenance of every contributing source, not just the nearest exemplar.

### Consistency point

The decision is linearized at the authoritative authorization check, with registry lifecycle state read in the same request path. Permissions can change after the check and before the model finishes. ContextLine does not retract already delivered tokens or guarantee distributed snapshot consistency with an external auth provider. Define acceptable revocation-to-response semantics with the auth system owner.

## 5. Capability 3: lifecycle propagation

### Event semantics

| Event | Registry effect | Storage effect |
|---|---|---|
| `permission_revoked` | Audit only; principals required | None. Authoritative ACL must already deny those principals; shared artifacts remain. |
| `permission_granted` | Audit only; principals required | None. Does not clear source-wide restriction or resurrect artifacts. |
| `source_restricted` | All source versions become `revoked` | Invalidate derivatives; memory may be flagged for review. |
| `source_reactivated` | Source versions become `active` | None. Previously invalidated artifacts stay blocked until explicitly regenerated/reviewed. |
| `document_updated` | Insert exactly current version + 1; old version stops being current | Invalidate old-version derivatives. |
| `document_deleted` | All versions become `deleted` | Delete all known derivatives. |
| `gdpr_erasure_requested` | All versions become `deleted` | Delete all known derivatives, including memory; legal review remains external. |
| `retention_expired` | All versions become `expired` | Delete all known derivatives. |

The original brief used `permission_revoked` ambiguously for both a person losing access and a document becoming globally restricted. This implementation separates those cases to avoid deleting data still authorized for other users.

### Durable execution

1. `recordSourceEvent` locks source versions, applies the registry lifecycle change, and inserts the event in the **same transaction**.
2. The worker claims an unmaterialized event with `FOR UPDATE SKIP LOCKED`.
3. It locks the source versions and snapshots dependent artifacts into unique per-event jobs. Source locks serialize this snapshot against new registrations.
4. Jobs are claimed separately with expiring leases. Each claim gets a UUID fencing token and increments its attempt count.
5. The connector performs delete/invalidate outside any database transaction, then verifies the actual storage state.
6. `finishJob` accepts the result only if its fencing token still owns the processing lease. It updates artifact state, bounded attempt history, and aggregate event progress transactionally.
7. Failed attempts back off. Exhaustion becomes a durable `failed` job (the dead-letter queue is a registry state, not a separate broker). An operator can explicitly requeue failed jobs.

Default delays are **1s, 5s, 30s, 5m, 30m**, with **six total attempts** (initial attempt plus five retries). A lease must exceed both connector operation timeouts plus database margin. A crashed worker's lease expires and another worker can reclaim the job. Idempotent connectors make at-least-once execution safe.

### Progress is not success

- `completed`: every job reached a completed workflow state (or there were no storage jobs). Delete/invalidate jobs require verification; a flagged job may instead be explicitly acknowledged by a reviewer while its artifact remains blocked. Inspect job actions and verification timestamps—event completion alone is not proof of physical deletion.
- `partial`: work remains, some jobs need review, or terminal review coexists with failures/retries.
- `failed`: all work is terminal and at least one job exhausted retries.
- `pending_review`: storage may still contain content, but the registry blocks serving. A human decision is outstanding.

Verification proves the connector's configured primary storage reference is absent or marked stale at verification time. It does not prove anything about replicas, backups, snapshots, unregistered derivatives, or model weights.

## 6. Defense in depth

Real-time enforcement is the primary protection for instrumented serving paths. Lifecycle propagation removes stale storage and produces evidence. If the worker is down, enforcement still denies. If a connector lies about success, verification prevents a completed registry state. If the registry is down, the SDK returns no content rather than guessing.

This is a **conditional fail-closed design**, not a universal guarantee: explicit fail-open settings, bypassed application paths, incorrect provenance, compromised trusted components, or a permissive auth callback can still cause disclosure.

## 7. Deployment topology

SDK instances and workers run near the application and registry. Multiple workers can share a tenant queue; PostgreSQL locks distribute claims. The current worker requires an explicit tenant list and uses one tenant context per transaction. A large deployment can run one worker pool per tenant or tenant cohort.

The demo runs all components in one process for convenience. Production should separate application replicas, worker replicas, PostgreSQL, and storage services, with independent credentials and network policy. See [deployment](deployment.md).
