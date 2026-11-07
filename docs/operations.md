# Operations runbook

## 1. What to monitor

The worker exposes Prometheus text at `/metrics` and a health endpoint at `/health`. The demo proxies the same worker metrics at `/api/metrics`.

| Metric | Type | Meaning |
|---|---|---|
| `contextline_worker_up` | Gauge | Worker CLI/demo process is serving metrics |
| `contextline_jobs_processed_total{tenant}` | Counter | Fenced job completions since process start, including acknowledged review workflows |
| `contextline_jobs_claimed_total{tenant}` | Counter | Claims, including reclaimed expired leases |
| `contextline_job_failures_total{tenant}` | Counter | Failed connector attempts, including attempts that will retry |
| `contextline_queue_jobs{tenant}` | Gauge | Pending/processing/retry jobs in the registry |
| `contextline_dead_letter_jobs{tenant}` | Gauge | Exhausted failed jobs |
| `contextline_review_jobs{tenant}` | Gauge | Flagged jobs awaiting acknowledgement |

Counters reset on process restart; queue gauges come from durable registry state. Tenant labels are escaped but may still be sensitive. The current build does not expose a full latency histogram, oldest-event-age gauge, or auth-callback metrics; add application/DB monitoring for those.

Suggested initial alerts (tune to your SLO):

- Dead letters > 0 for 5 minutes: page the service owner.
- Review jobs > 0 beyond the agreed review SLA: route to the privacy/security queue.
- Queue depth growing for 10 minutes or oldest pending event beyond the propagation objective: investigate worker/store health.
- Registry/auth/audit diagnostics increasing: expect fail-closed retrieval degradation.
- Verification failures repeatedly occurring: investigate wrong store, permissions, consistency, or connector behavior.

## 2. Inspect a lifecycle event

Use a trusted administrative interface or a PostgreSQL session with the correct tenant GUC:

```sql
BEGIN;
SELECT set_config('app.current_tenant', 'acme-corp', true);
SELECT event_id, source_id, event_type, status,
       affected_artifacts, processed_artifacts, created_at, completed_at
FROM contextline.lifecycle_events
ORDER BY created_at DESC LIMIT 20;

SELECT job_id, artifact_id, action, status, attempts, max_attempts,
       next_attempt_at, lease_until, last_error_code, verified_at, history
FROM contextline.lifecycle_jobs
WHERE event_id = 'EVENT_UUID'
ORDER BY created_at;
COMMIT;
```

Do not infer physical deletion from event status alone. Delete/invalidate jobs require `verified_at`; flag jobs can be acknowledged while the artifact remains blocked. Inspect action and history.

Programmatic equivalents: `registry.getEvent`, `listEvents`, `listJobs`, `queueStats`.

## 3. Retries and dead letters

Automatic retries use exponential backoff. `retry` with a future `next_attempt_at` is normal; do not reset it merely because it is not immediate.

After fixing the underlying cause, requeue exhausted jobs:

```ts
const count = await registry.retryEvent('acme-corp', eventId);
```

This resets only `failed` jobs to pending with a fresh attempt budget. It does not approve review jobs or change connector configuration. Record the operator action in your change-management system; job history retains prior attempts.

If a job is stuck in `processing`, check `lease_until`. A live worker may still own it. After lease expiry, another worker can reclaim it. Do not manually clear a lease while the connector operation is active unless you understand the side-effect and fencing implications.

## 4. Human-review queue

`source_restricted` defaults to flagging memory artifacts. The registry marks them `pending_review`, so they cannot be served, but storage content remains until a decision is made.

Review questions:

- Does the memory contain synthesized knowledge from multiple sources?
- Is deletion required, or is continued blocked retention appropriate?
- Are there downstream copies or legal retention obligations?
- Would regeneration from currently authorized roots be safer than restoring the old artifact?

To acknowledge review while keeping the artifact blocked:

```ts
await registry.acknowledgeReview('acme-corp', jobId, 'operator:security-42');
```

The job workflow completes, the reviewer is recorded, and the artifact remains `pending_review`. This is not deletion and not restoration. If deletion is required, issue the appropriate source deletion/erasure event so all known derivatives are handled consistently. A per-artifact restore/unlearning workflow is not implemented.

## 5. Common incidents

### Registry unavailable

**Symptoms:** empty authorized results, `REGISTRY_UNAVAILABLE` diagnostics, registration/event failures.  
**Action:** check PostgreSQL health, pool saturation, connection timeouts, credentials, and failover. Do not switch to ungoverned retrieval as a fallback. Restore service; durable events remain queued.

### Authorization service unavailable

**Symptoms:** `authorization_timeout`/`authorization_error` decisions.  
**Action:** check the authoritative service and callback mapping. Keep fail-closed defaults. Fail-open is an explicit risk decision, not an automatic recovery tactic. The auth cache is opt-in and disabled by default; there is no circuit breaker yet.

### Worker down

**Symptoms:** queue growth, no recent claims.  
**Action:** restart/scale workers. Retrieval enforcement continues. Check tenant configuration includes the affected tenant. Events are durable; no broker replay is required.

### Connector outage or verification failure

**Symptoms:** retry/dead-letter jobs, sanitized error codes.  
**Action:** inspect private connector/service logs, credentials, table/key mapping, tenant prefix, and read-after-write behavior. Fix the cause, then requeue dead letters. Never mark the registry deleted solely because the delete API returned 200.

### Unexpected authorized content after revocation

1. Confirm the authoritative ACL actually denies the principal/source.
2. Confirm the serving path calls ContextLine with the correct tenant/principal and current artifact version.
3. Inspect access decisions and explicit overrides (`allow`, `best_effort`, outdated-version allowance).
4. Confirm the artifact has complete root provenance and was not served from an ungoverned path.
5. Check whether the response was already in flight before revocation; define the consistency window.
6. Preserve evidence, contain the path, and follow the incident process. Do not assume cleanup alone fixes an authorization bug.

### Suspected missing provenance

Use `quarantined`/`unregistered` decisions as a backfill manifest. Identify the producing pipeline and root sources, register current artifacts through a reviewed process, and reconcile or delete orphans. Historical/noncurrent imports require a separate reviewed workflow; the default registration API rejects them.

## 6. Backup, restore, and erasure

Back up PostgreSQL with WAL/PITR using your standard tooling. Test restore regularly. The registry contains metadata and audit evidence, not document content, but it can still be sensitive.

A restore can reintroduce old lifecycle states. Maintain a durable replay ledger of source deletion/restriction events outside the restored snapshot or reapply authoritative lifecycle state before enabling serving. Keep serving fail-closed until replay/reconciliation completes. Connectors must be rechecked after restore because external storage may have changed independently.

Backups of derivative stores are not erased by the primary-store connector. Define backup expiry, restore-time tombstone replay, and any legally required notification/erasure process. Record exceptions and evidence. “We deleted the primary row” is not a comprehensive backup-erasure claim.

Audit retention is not automatic. Export required evidence to approved storage, then purge under a privileged maintenance workflow. Runtime roles intentionally lack core DELETE.

## 7. Local demo recovery

The demo cluster lives in `.contextline/demo-db`. Check status before taking action:

```bash
PGCTL=node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl
"$PGCTL" -D .contextline/demo-db status
# Only if it is running and you intend to stop the demo:
"$PGCTL" -D .contextline/demo-db -m fast -w stop
```

Do not remove `postmaster.pid` while a server is alive. Logs are in `.contextline/demo-db/server.log`. The demo's internal port can vary after recovery; the application configures the port it started. Unix sockets are placed in a short temporary directory because deep checkout paths can exceed PostgreSQL's socket-path limit. Temporary CLI/test/smoke clusters use random directories and ports and clean up after themselves.

**Reset demo** clears only the selected tenant's synthetic registry/audit/demo rows and reseeds it. It pauses the worker during reset. It is not a production retention or erasure tool.

## 8. Change management

- Add migrations; never edit applied SQL.
- Version connector configuration and review tenant/table/key changes.
- Test new connectors with false-success and cross-tenant cases before production.
- Roll out SDK changes canary-style with deny/quarantine telemetry.
- Record security-policy overrides and review them periodically.
- Keep the demo, test credentials, and local database directories out of production images and secrets stores.


## Quarantine backfill CLI

```bash
export CONTEXTLINE_DATABASE_URL=postgresql://contextline_app:...@db/app   # runtime role
contextline-migrate quarantine list --tenant acme            # open manifest rows, JSON
contextline-migrate quarantine list --tenant acme --all      # include resolved
contextline-migrate quarantine backfill --tenant acme --file mappings.json
contextline-migrate quarantine resolve --tenant acme --artifact answer:123@1
```

`mappings.json`:

```json
[
  {
    "artifactId": "answer:123",
    "artifactVersion": 1,
    "type": "cache",
    "connectorId": "redis",
    "storageRef": "redis:answers:acme:answer:123",
    "ownerPrincipal": "usr_8f21",
    "sources": [{ "id": "doc:q3-revenue", "version": 1 }]
  }
]
```

Backfill goes through the same immutable, race-checked registration path as ingestion, then marks the
manifest rows resolved. Failures are reported per artifact with a stable error code and a nonzero exit
status; nothing is silently skipped. Move `unregisteredPolicy` from `quarantine` to `deny` only when the
open manifest is empty for that tenant.

## Worker metrics

| Metric | Type | Meaning |
|---|---|---|
| `contextline_worker_up` | gauge | The worker loop is running |
| `contextline_jobs_processed_total` | counter | Verified completions |
| `contextline_job_failures_total` | counter | Failed attempts, including retries |
| `contextline_jobs_claimed_total` | counter | Claims taken |
| `contextline_queue_jobs` | gauge | Pending/processing/retry jobs |
| `contextline_dead_letter_jobs` | gauge | Exhausted or non-retryable jobs — **alert on this** |
| `contextline_review_jobs` | gauge | Jobs awaiting a human decision |
| `contextline_connector_healthy` | gauge | Last connector health check, per connector |

Alert guidance: `contextline_dead_letter_jobs > 0` pages immediately (a revocation did not propagate);
`contextline_connector_healthy == 0` warns before jobs start failing; a growing `contextline_queue_jobs`
with a flat processed counter means the worker is stuck or under-provisioned.

## Worker timing defaults

| Setting | Default | Notes |
|---|---|---|
| `intervalMs` | 1000 | Idle tick |
| `eventsPerPass` | 5 | Events materialized per tenant per pass |
| `batchSize` / `concurrency` | 20 / 4 | Jobs claimed / connector calls in flight |
| `leaseMs` | 60000 | A killed worker's jobs are reclaimable after this |
| `heartbeatMs` | lease/3 (20000 at the default lease) | Extends the lease while a call is genuinely running |
| `retryDelaysMs` | 1s, 5s, 30s, 5m, 30m | With ±10% jitter (`retryJitter`) |
| `maxAttempts` | 6 | Initial attempt plus five retries, then dead letter |
| `drainTimeoutMs` | 30000 | Stop claims, finish in-flight work, then exit |

Configuration faults (`UNKNOWN_TABLE`, `INVALID_STORAGE_REFERENCE`, `CONNECTOR_NOT_CONFIGURED`,
`TENANT_PREFIX_REQUIRED`, `INVALID_TABLE_CONFIGURATION`, `INVALIDATION_NOT_SUPPORTED`) dead-letter on the
**first** attempt: retrying a misconfiguration only delays the alert.
