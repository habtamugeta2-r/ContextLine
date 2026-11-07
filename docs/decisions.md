# Architecture and product decision records

These records explain consequential choices and their trade-offs. They are not claims that every alternative was benchmarked.

## ADR-001: Customer callback, not a replacement policy engine

**Context:** Enterprises already have authoritative ACL/relationship systems. Reimplementing policy evaluation creates drift and adoption cost.  
**Decision:** Accept a strict batched `authorize({ tenantId, principal, sources })` callback. Require exactly one boolean per requested source.  
**Consequences:** ContextLine depends on callback correctness/latency. No built-in ReBAC/ABAC language, token validation, or identity provider polling. Future adapters must preserve authority and freshness semantics.

## ADR-002: Flatten transitive lineage to root sources

**Context:** Enforcement needs every contributing root, not necessarily the full derivation DAG.  
**Decision:** Resolve `derivedFrom` parents at registration and store the union of root source versions. Reject unknown parents and conflicting versions.  
**Consequences:** Simple, fast authorization and propagation. Intermediate graph visualization/impact paths are not available; add a separate lineage model if needed.

## ADR-003: Principal revocation is not source deletion

**Context:** The brief used “revocation” ambiguously. Deleting shared derivatives when one user loses access would break other authorized users.  
**Decision:** `permission_revoked/granted` require principals and are audit-only. Source-wide restriction/deletion/erasure are explicit events.  
**Consequences:** The authoritative ACL must actually change before/with the audit event. ContextLine does not mutate external auth. Source reactivation does not resurrect invalidated artifacts.

## ADR-004: Seven tables instead of four

**Context:** Aggregate events alone cannot express per-artifact leases, attempts, verification, and durable access evidence.  
**Decision:** Keep sources/artifacts/dependencies/lifecycle_events; add lifecycle_jobs/access_runs/access_decisions.  
**Consequences:** More schema surface, but explicit durability and audit semantics. Migration ledger is owner-only. Future retention/partitioning must account for audit growth.

## ADR-005: Forced RLS plus least-privilege runtime role

**Context:** Tenant predicates alone are easy to forget; RLS alone is bypassed by privileged roles.  
**Decision:** Tenant-inclusive keys/FKs, forced RLS, transaction-local GUC, non-owner NOSUPERUSER NOBYPASSRLS runtime, append-only audit grants.  
**Consequences:** Strong defense in depth for ordinary runtime access. Privileged operators remain trusted; external WORM is needed for stronger audit immutability.

## ADR-006: Durable outbox and verified jobs, not fire-and-forget cleanup

**Context:** Source changes must survive worker crashes and connector failures.  
**Decision:** Record lifecycle state and event atomically; materialize jobs under source locks; claim with SKIP LOCKED and expiring leases; verify connector outcomes; fence commits.  
**Consequences:** At-least-once external effects require idempotent connectors. External publication races remain an application responsibility. Dead letters/review are registry states, not a separate broker.

## ADR-007: Required audit by default

**Context:** Returning content without evidence weakens the security-review story.  
**Decision:** Default `auditPolicy: required`; audit failure returns no candidates. Explicit `best_effort` exists for controlled availability trade-offs.  
**Consequences:** Registry/audit outage affects availability. An `allowed` decision records authorization, not proof of final model delivery. Batch audit inserts reduce round trips; local durable latency still exceeds the draft target.

## ADR-008: No authorization-result cache in v0.1

**Context:** Caching permissions can reintroduce the stale-access problem the product addresses.  
**Decision:** Invoke the authoritative callback for each enforcement call's unique eligible roots.  
**Consequences:** Higher latency/load than a cache. Future caching needs bounded staleness, invalidation, and explicit risk acceptance; circuit breakers must not silently fail open.

## ADR-009: Unknown artifacts deny; quarantine is evidence, not permission

**Context:** Incremental adoption needs visibility without accidental disclosure.  
**Decision:** Default deny; quarantine records a backfill manifest and still denies; explicit rollout allow is temporary and never overrides known tombstones/lifecycle blocks.  
**Consequences:** Backfill is required for availability. Coverage claims must distinguish instrumented paths from unknown artifacts.

## ADR-010: Review acknowledgement keeps memory blocked

**Context:** Flagged memory may contain synthesized multi-source knowledge; automatic deletion or restoration can both be wrong.  
**Decision:** Artifacts become `pending_review` and cannot serve. An operator may acknowledge the workflow while keeping the artifact blocked; erasure events perform deletion.  
**Consequences:** Event completion can mean “review resolved,” not “storage deleted.” Inspect job action/verification. Per-artifact restore/unlearning is deferred.

## ADR-011: Three qualified adapter families first

**Context:** The brief listed many stores; shipping untested adapters would create false coverage claims.  
**Decision:** Implement generic PostgreSQL, pgvector deletion, and Redis delete/TTL-preserving invalidation, plus a custom interface and live-test paths.  
**Consequences:** Other stores are roadmap. pgvector search/index tuning and Redis replica semantics remain operator responsibilities.

## ADR-012: Synthetic local demo, no LLM dependency

**Context:** The core value is authorization/lifecycle, not model quality. API keys would add cost and obscure deterministic evidence.  
**Decision:** Browser dashboard + CLI with synthetic facts, deterministic retrieval, real PostgreSQL registry/worker, and separate demo stores.  
**Consequences:** Easy reproducibility; not a production RAG benchmark. Identity selectors are explicitly not authentication. Redis/pgvector are tested separately.

## ADR-013: Honest evidence over unsupported absolutes

**Context:** The brief contained market, legal, latency, and competitor claims without sufficient evidence.  
**Decision:** Record a research ledger, label hypotheses, publish actual local measurements and skipped environments, and gate roadmap items by evidence.  
**Consequences:** Documentation is longer and less promotional, but security questionnaires and design-partner conversations can rely on it.

## ADR-014: Self-managed first, hosted control plane later

**Context:** A SaaS control plane adds tenancy, SSO, billing, and operational risk before the core loop is validated.  
**Decision:** Ship SDK/registry/worker/configuration and a local demo. Defer hosted control plane until design partners prove repeated need and buying intent.  
**Consequences:** Tenant lists and connector config are deployment-managed. Dynamic discovery and centralized administration are future work.
