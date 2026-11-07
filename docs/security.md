# Security model

## 1. What ContextLine claims

Under the integration contract below, ContextLine enforces this rule before returning a candidate through its SDK:

> A candidate is returned only if it has registered, nonempty root provenance; its artifact and root lifecycle states permit serving; its version policy permits serving; and the customer's authoritative authorization callback explicitly allows every root source for the current tenant and principal.

The default path also requires the access decision to be durably recorded before returning content. Unknown artifacts and uncertain authorization are denied. Lifecycle cleanup is independent of this serving decision.

This is not a claim that every AI application is secure, that no existing product addresses RAG authorization, or that a single failure anywhere can never cause a leak.

## 2. Integration contract

The application must:

1. Authenticate the principal and derive the tenant from trusted server-side state.
2. Route every governed retrieval, cache hit, summary injection, and agent-memory read through the SDK.
3. Register complete root provenance before publication and fence/reconcile external storage writes.
4. Supply an authoritative authorization callback with correct current permissions and strict boolean results.
5. Change authoritative permissions before or atomically with recording the corresponding audit event. ContextLine does not mutate your auth system.
6. Use a dedicated PostgreSQL runtime role with `NOSUPERUSER NOBYPASSRLS`, not the schema owner.
7. Configure connectors for the correct tenant-aware stores and verify their actual behavior.
8. Keep explicit rollout/debug overrides out of production security policies.
9. Protect direct storage access, backups, logs, traces, and downstream outputs with separate controls.

If any of these is false, the corresponding guarantee does not hold.

## 3. Default decision matrix

| Condition | Default result | Audit reason |
|---|---|---|
| Active artifact, active/current roots, all callback results true, audit committed | Allow | `allowed` |
| No registry record | Deny | `unregistered` |
| No record, quarantine rollout mode | Deny and create backfill evidence | `quarantined` |
| Registered artifact with no roots | Deny | `empty_provenance` |
| Artifact deleted/stale/pending review | Deny | `artifact_deleted`, `artifact_stale`, `artifact_pending_review` |
| Any root deleted/revoked/expired | Deny | `source_deleted`, `source_revoked`, `source_expired` |
| Any root version is not current | Deny | `source_outdated` |
| Any root callback result false | Deny | `authorization_denied` |
| Callback throws or returns malformed results | Deny | `authorization_error` |
| Callback exceeds timeout | Deny | `authorization_timeout` |
| Registry lookup unavailable | Deny all candidates | Diagnostic; no durable decision can be written |
| Required audit write unavailable | Deny response | Diagnostic; an earlier authorization decision may exist but is not proof of delivery |

Invalid API inputs, duplicate candidates, oversized batches, and mismatched run identities are programming errors and throw `ContextLineError`; callers must not convert exceptions into permissive results.

### Explicit overrides

- `unregisteredPolicy: "allow"` permits **unknown** artifacts during a controlled rollout. It never overrides a known tombstone, stale artifact, or lifecycle-blocked root.
- `onError: "allow"` permits known, otherwise eligible artifacts when authorization fails. This is a debugging/availability override, not the security default. It is audited as `authorization_allow_override`.
- `onError: "skip"` removes affected candidates and records outcome `skipped`.
- `allowOutdatedVersions: true` relaxes freshness only. Deleted/revoked/expired roots still deny.
- `auditPolicy: "best_effort"` permits otherwise authorized content when audit persistence fails. Use only with an explicit risk acceptance and external monitoring.

There is no SDK authorization-result cache in v0.1.0. Every enforcement call invokes the callback for its unique eligible roots. This avoids introducing a second stale-permission window. A future cache must define bounded staleness and cross-process invalidation before being enabled.

## 4. Tenant isolation

Every core table includes `tenant_id` in its primary key and foreign-key relationships. PostgreSQL policies use:

```sql
USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''))
WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), ''))
```

The SDK sets this value with `set_config(..., true)` inside each transaction. A missing setting yields no rows. `FORCE ROW LEVEL SECURITY` subjects ordinary owners to policies too, but **superusers and BYPASSRLS roles still bypass RLS**. Runtime must not use those roles.

Composite foreign keys include tenant ID, preventing an edge from tenant A's artifact to tenant B's source. Tests exercise both wrong-tenant writes and cross-tenant edges.

Storage isolation is connector-specific:

- PostgreSQL/pgvector adapters always include the configured tenant column in mutation and verification predicates.
- Redis requires the storage key to begin with the exact tenant ID plus `:` by default. Disabling this requires a dedicated per-tenant client/store and explicit risk acceptance.
- Custom connectors must enforce equivalent isolation. A connector that trusts an arbitrary storage reference without tenant context is unsafe.

The worker's tenant list is operator configuration, not end-user input. The demo's tenant selector is explicitly not an authentication boundary.

## 5. Least privilege and audit integrity

`grantRuntimeRole` checks that the role exists, can log in, is not superuser/BYPASSRLS, and does not own the registry tables. It grants:

- `SELECT, INSERT, UPDATE`: sources, artifacts, lifecycle events/jobs.
- `SELECT, INSERT`: dependencies, access runs, access decisions.
- No core `DELETE`, no migration-ledger access, no schema ownership.

Audit rows are append-only under the runtime role, not cryptographically immutable. A database owner or compromised privileged operator can alter them. For stronger evidence, export to WORM storage, sign checkpoints, or use an external append-only log. Retention and legal holds must be designed separately.

Registration and event APIs are trusted application APIs. Anyone with runtime database credentials can fabricate metadata within their tenant. Database credentials are a high-value secret.

## 6. Injection and input handling

- Registry values use parameterized SQL. Schema/table names are validated against a narrow identifier grammar.
- Candidate limits: 100 per call. Registration: up to 100 artifacts and 100 resolved roots. IDs: 512 characters; storage references: 1,024; connector IDs: 64.
- Control characters and empty identifiers are rejected. Versions are positive 32-bit integers.
- Authorization callbacks must return exactly the requested source IDs with boolean values.
- Connector table names come only from operator configuration, never from artifact references.
- Demo mutations require JSON, a 32 KiB body limit, an action allowlist, and same-origin browser checks. Static files and documentation paths are constrained.
- Diagnostics contain codes and operation names, not callback errors, connection strings, prompts, or content.

These controls reduce injection risk; they do not replace network isolation, TLS, secret management, dependency auditing, or secure application coding.

## 7. Failure behavior

| Failure | Security behavior | Availability impact |
|---|---|---|
| Registry down | SDK denies; registration/events throw | Governed AI retrieval unavailable or degraded |
| Auth service down | Default deny after timeout | Authorized users may be blocked |
| Worker down | Serving checks continue; cleanup delayed | Queue grows |
| Connector down | Retries/dead letters; registry still blocks | Storage cleanup delayed |
| Verification false | Retry; never mark deleted from success alone | Event remains incomplete |
| Worker crash after side effect | Lease expires; idempotent retry | Possible duplicate connector operation |
| Stale worker after lease reclaim | Fencing token rejects its registry commit | External side effect must still be idempotent |
| Audit down | Default deny; optional best-effort override | Reduced availability |
| Registration crash before publish | Orphan metadata; no content served | Reconciliation needed |
| Publish without registration | Default deny on governed path | Direct bypass remains possible |

A circuit breaker, auth-result cache, and automatic orphan discovery are not implemented in this release. They are roadmap items with explicit safety requirements.

## 8. Privacy and erasure

“Metadata only” does not mean “no personal data.” An email principal, document title embedded in an ID, customer tenant name, or storage path can identify a person or reveal confidential relationships. Minimize identifiers, use opaque IDs where practical, encrypt transport/storage, restrict access, and define retention.

GDPR Article 17 requires erasure without undue delay when specified grounds apply and includes exceptions. Pseudonymized data can remain personal data. The registry's `gdpr_erasure_requested` event is a technical deletion workflow over **registered primary-store derivatives**. It does not decide whether a legal request is valid, erase model weights, satisfy every backup obligation, or certify compliance.

For erasure operations:

1. Validate the request and scope with the controller/privacy owner.
2. Block serving through source lifecycle state.
3. Delete registered derivatives, including memory; do not substitute human-review flagging for required erasure.
4. Track connector verification and failures.
5. Handle backups, replicas, downstream recipients, traces, and legal holds through the documented external process.
6. Retain only the minimally necessary evidence under an approved schedule.

See the primary legal sources and qualifications in [research](research.md). This document is engineering guidance, not legal advice.

## 9. Out of scope

Prompt injection, jailbreaks, output guardrails, content classification, masking, model-weight unlearning, training-data extraction, direct storage bypass, unregistered copies, already delivered answers, and downstream screenshots/exports are not solved by this layer. Use complementary controls and include them in the threat model.

## 10. Security review evidence

A precise questionnaire response for an integrated deployment is:

> “Governed AI artifacts are registered against versioned root sources. Before retrieval or cache serving, the application checks artifact/root lifecycle state and obtains current authorization for every root from our authoritative service. Unknown provenance and authorization failures are denied by default. Source lifecycle events create durable propagation jobs; configured connectors delete or invalidate derivatives and verify the resulting storage state. Access decisions and lifecycle outcomes are recorded for audit. Coverage is limited to instrumented paths and registered stores; backups, model weights, and downstream copies are handled by separate controls.”

Attach the actual connector inventory, coverage report, test results, retention policy, and incident runbook. Do not claim universal protection or compliance from the existence of this repository alone.
