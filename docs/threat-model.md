# Threat model

## 1. Assets

- Confidential source content and AI derivatives in customer stores.
- Source-to-artifact relationships, which can reveal sensitive business activity even without content.
- Principal/tenant identifiers and access decision history.
- Authoritative authorization decisions and registry lifecycle state.
- Storage credentials and connector configuration.
- Worker integrity, audit evidence, and availability of governed AI features.

## 2. Trust boundaries

| Boundary | Trusted input | Validation/control |
|---|---|---|
| End user → application | Authenticated session | Application authentication; ContextLine does not authenticate users |
| Application → SDK | Tenant, principal, candidate IDs, provenance | Server-derived identity; input bounds; immutable registration; audit |
| SDK → auth service | Source IDs and principal | Customer callback; strict boolean map; timeout; default deny |
| SDK/worker → PostgreSQL | Tenant-scoped transactions | Parameterized SQL; forced RLS; least-privilege non-owner role |
| Worker → storage | Connector ID and storage reference | Operator allowlist; tenant predicates/prefixes; verification |
| Operator → admin functions | Event/retry/review decisions | Must be protected by deployment's admin authorization; demo is synthetic only |
| Registry → backup/restore | Snapshot and lifecycle history | External replay/reconciliation process required |

## 3. Attacker models

1. **Unauthorized principal:** attempts to retrieve restricted content through RAG, cache, or memory.
2. **Cross-tenant user:** guesses another tenant's source/artifact IDs or storage keys.
3. **Malicious/buggy producer:** omits provenance, rewrites artifact identity, or publishes after deletion.
4. **Compromised application process:** can call trusted SDK APIs and access configured stores; largely inside the trust boundary.
5. **Storage failure/deception:** returns success without deleting, serves stale replicas, or becomes unavailable.
6. **Worker crash/duplication:** loses in-memory state or retries after a side effect.
7. **Database/operator compromise:** can bypass RLS or alter metadata/audit; privileged trust boundary.
8. **Prompt attacker:** tries to make the model disclose or act on context. Mostly outside this layer except ensuring unauthorized context is not supplied.

## 4. Abuse cases and mitigations

| Abuse case | Control | Residual risk |
|---|---|---|
| Restricted chunk enters prompt | Backward roots + all-source auth before return | Uninstrumented path or incorrect provenance |
| Cache hit bypasses auth | `assertCanServe` on every hit | Semantic-cache provenance incomplete; direct cache bypass |
| One user's revocation deletes another's data | Principal events are audit-only; source-wide events separate | Application may incorrectly choose source-wide event |
| Cross-tenant registry lookup | Tenant-inclusive keys/FKs + forced RLS | Privileged role or compromised application lying about tenant |
| Cross-tenant Redis deletion | Exact tenant prefix required by default | Prefix disabled without physical isolation; wrong connector credentials |
| SQL injection through storage ref | Values parameterized; table keys allowlisted | Custom connector misuse |
| Unknown artifact served | Default deny; quarantine evidence | Explicit rollout allow policy |
| Auth outage causes leak | Timeout + default deny | Explicit fail-open override |
| Delete API lies | Independent verify before registry completion | Verification endpoint itself stale/compromised |
| Worker crashes after delete | Lease expiry + idempotent retry | External side effects may repeat |
| Stale worker commits after reclaim | UUID fencing token | Cannot fence an arbitrary external store without connector support |
| Late registration after deletion | Source locks + active/current root requirement | External publication can still race without application fence |
| Artifact resurrection via retry | Immutable deleted-version tombstone | New identity/version can publish new content and needs governance |
| Old content after update | Current-version check + old-version invalidation | Explicit outdated override |
| Memory fact survives restriction | Flagged artifact blocked; erasure deletes | Physical retention until review/deletion; unregistered copies |
| Audit tampering by runtime | Append-only grants, no core DELETE | Owner/privileged operator can alter; external WORM needed |
| Backup restore reintroduces data | Replay lifecycle tombstones before serving | Process must be implemented and tested externally |
| Prompt injection/output leak | Complementary guardrails/output controls | Not solved by ContextLine |

## 5. Important race: registration versus publication

Registry source locks serialize metadata registration with lifecycle snapshots. They do not lock Redis, a vector service, or an application transaction in another database.

Unsafe sequence:

```text
register artifact → source deleted → worker verifies absent storage →
producer writes old content to storage
```

The registry artifact is deleted, so governed SDK serving denies it. But physical storage now contains an orphan, and direct bypass could read it. Required application controls include a publish fence/generation check, transactional outbox, or reconciliation that detects writes after the lifecycle epoch. This residual risk is explicit; the product does not claim distributed atomicity it cannot provide.

## 6. Authorization consistency window

A permission can change after the callback returns and before the answer is delivered. ContextLine's decision reflects the auth service at check time. Streaming responses, long agent runs, and downstream caches need additional revalidation/cancellation policies appropriate to their risk. Already delivered information cannot be retracted by deleting an embedding.

## 7. Availability attacks

An attacker can increase candidate fan-out, root cardinality, audit volume, or lifecycle event rate. Bounds (100 candidates/roots/artifacts, bounded worker batches) limit individual calls but do not provide request-rate quotas. Deploy application rate limiting, connection budgets, queue alerts, and tenant fairness. The worker round-robins configured tenants but does not implement weighted quotas or per-tenant cost accounting.

Fail-closed behavior trades availability for confidentiality. An auth/registry outage can be a denial-of-service condition. Capacity and fallback planning are security concerns, not reasons to silently fail open.

## 8. Privacy boundaries

Metadata can be personal data. Principal IDs, source IDs, storage paths, and reviewer IDs are stored. The demo uses synthetic names; production should minimize and pseudonymize where appropriate, restrict access, encrypt, and define retention. Pseudonymization is not automatic anonymization.

Erasure events cover registered primary derivatives. Legal grounds/exceptions, backups, recipients, traces, and model weights require a separate controller-led process. No compliance certification is implied.

## 9. Assumptions to validate with design partners

- Producers can preserve complete root provenance at acceptable cost.
- Authoritative auth can answer batched source checks within the latency budget.
- Storage connectors can provide truthful, tenant-scoped verification.
- Teams will instrument all serving paths, not just vector search.
- Audit volume and retention are operationally acceptable.
- Publication fencing/reconciliation can be integrated without excessive friction.

These are product risks as well as security risks. The roadmap prioritizes evidence for each.
