# Research and evidence ledger

**Research date:** 2026-11-07. **Scope:** technical prior art, security guidance, privacy constraints, and product positioning for a source-aware AI derivative access layer. **Method:** primary vendor/government documentation where reachable, targeted search results for discovery, and local executable experiments. No customer interviews, paid analyst reports, independent vendor benchmarks, or market-share datasets were obtained.

This document separates **verified source statements**, **local measurements**, **design decisions**, and **unvalidated business hypotheses**. It deliberately does not turn the supplied brief's confident claims into facts.

## 1. Executive findings

1. Permission leakage through embeddings and cross-context retrieval is a recognized risk. OWASP's 2025 LLM08 entry describes unauthorized access, cross-context leaks, inversion, and poisoning, and recommends permission-aware stores, logical partitioning, trusted-source validation, and immutable retrieval logs [1](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/). This supports the problem class; it does **not** prove access control is the single largest barrier to enterprise AI adoption.
2. Permission-aware RAG and relationship authorization already exist. OpenFGA documents contextual tuples and authorization checks; AWS describes pre-filtering plus real-time re-verification for RAG [5](https://openfga.dev/docs/modeling/token-claims-contextual-tuples) [6](https://aws.amazon.com/blogs/architecture/secure-multi-tenant-rag-with-amazon-bedrock-and-verified-permissions/). The defensible wedge is the combination of cross-store root provenance, serving enforcement, and verified lifecycle propagation—not “nobody does AI authorization.”
3. Vector stores already provide tenant partitioning and metadata filtering. Pinecone documents namespaces and metadata-based multitenancy patterns [4](https://docs.pinecone.io/guides/data/implement-multitenancy). ContextLine must integrate with these controls rather than claim to invent tenant filtering.
4. “Metadata only” is not a privacy exemption. GDPR treats identifiability contextually; Article 17 has grounds, deadlines, and exceptions. Source IDs, principal IDs, and storage references can be personal or confidential. Technical deletion evidence is useful but not compliance certification [2](https://eur-lex.europa.eu/eli/reg/2016/679/art_17/oj).
5. NIST's Generative AI Profile is voluntary risk-management guidance, not a mandate to buy a particular product. It was released July 26, 2024; the broader AI RMF is also voluntary [7](https://www.nist.gov/itl/ai-risk-management-framework). Use it to structure governance questions, not as a compliance guarantee.
6. Database isolation has privileged bypasses. PostgreSQL RLS does not constrain superusers/BYPASSRLS roles, and owner behavior requires FORCE [3](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). Least-privilege runtime roles are a necessary deployment condition.
7. The draft's `<5ms p95` target is not met by the current local durable-audit path. The measured synthetic p95 is about **137ms** on the sandbox's two-vCPU/four-GiB environment; see [validation](validation.md). This is not a production benchmark, but it is direct evidence against publishing the target as an achieved result.
8. Market size, willingness to pay, “top blocker” rankings, competitor ARR, and conversion rates remain unverified. Corporate transactions such as Okta/Auth0 and IBM/HashiCorp show strategic interest in identity/infrastructure, not demand for this specific product [8](https://www.okta.com/press-room/press-releases/okta-to-acquire-auth0/) [9](https://newsroom.ibm.com/2025-02-27-ibm-completes-acquisition-of-hashicorp,-inc.).

## 2. Claim audit of the supplied thesis

| Original claim/theme | Evidence status | Correction/action in this repository |
|---|---|---|
| Access control is the #1 enterprise AI blocker | Unverified ranking | Treat as a discovery hypothesis; OWASP supports risk existence, not rank [1](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/) |
| No existing solution addresses AI authorization | Contradicted by adjacent systems | Compare OpenFGA, permission-aware RAG patterns, vector-store controls, and governance platforms [5](https://openfga.dev/docs/modeling/token-claims-contextual-tuples) [6](https://aws.amazon.com/blogs/architecture/secure-multi-tenant-rag-with-amazon-bedrock-and-verified-permissions/) |
| Vector databases cannot enforce permissions | Too absolute | They provide filtering/partitioning primitives; application-level source authorization and lifecycle propagation remain separate concerns [4](https://docs.pinecone.io/guides/data/implement-multitenancy) |
| Metadata-only means GDPR does not apply | Incorrect/unsafe | Privacy review of identifiers and relationships; conditional erasure workflow [2](https://eur-lex.europa.eu/eli/reg/2016/679/art_17/oj) |
| AI regulation mandates this exact deletion architecture | Unsupported | Use voluntary NIST guidance and legal review; do not claim a statutory product mandate [7](https://www.nist.gov/itl/ai-risk-management-framework) |
| Fail-closed means no leak is possible | Too absolute | Conditional guarantee with explicit overrides and integration contract; see [security](security.md) |
| `<5ms p95` authorization overhead | Target, not achieved | Publish measured local result and a realistic load-test plan [validation](validation.md) |
| Four tables are sufficient | Insufficient for implemented durability/audit | Seven tables: add jobs, access runs, decisions; preserve four domain concepts [schema](schema.md) |
| Principal revocation should delete derivatives | Unsafe for shared data | Principal events are audit-only; source-wide restriction/deletion is explicit [architecture](architecture.md) |
| Connector success proves deletion | Insufficient | Independent verification, retries, dead letters, fencing [connectors](connectors.md) |
| Full lineage graph is required for enforcement | Not necessary for v0.1 | Flatten transitive roots; graph visualization is roadmap [decisions](decisions.md) |
| Ten-plus connectors ship immediately | Over-scoped | Ship PostgreSQL/pgvector/Redis plus custom interface; qualify others later |
| Hosted control plane exists | Not built | Configuration-only local control surface; hosted service is roadmap |
| TAM/SAM/SOM and ARR figures are established | Unverified | Show assumptions and formulas, label estimates, validate through discovery [product-strategy](product-strategy.md) |
| HashiCorp is an independent IPO comparator | Stale | IBM completed its acquisition in February 2025 [9](https://newsroom.ibm.com/2025-02-27-ibm-completes-acquisition-of-hashicorp,-inc.) |

## 3. Technical prior art

### Relationship authorization and contextual checks

OpenFGA's documentation describes contextual tuples supplied at check time and task/session/agent scoping patterns. This is relevant prior art for dynamic authorization without permanently writing every transient relationship. Token-claim-derived tuples can become stale until token expiry, and contextual tuples are not a complete historical change feed [5](https://openfga.dev/docs/modeling/token-claims-contextual-tuples). Implication: ContextLine should call the customer's authoritative checker and avoid assuming an authorization index is current.

### Permission-aware RAG

AWS architecture guidance combines policy checks with metadata filtering before vector search; related guidance emphasizes real-time re-verification against the source of truth [6](https://aws.amazon.com/blogs/architecture/secure-multi-tenant-rag-with-amazon-bedrock-and-verified-permissions/). These patterns are logical application isolation, not a universal storage guarantee. Implication: pre-filter for efficiency, re-check at serve time for safety, and document middleware failure modes.

### Vector-store isolation and filtering

Pinecone namespaces/metadata filters are established multitenancy tools [4](https://docs.pinecone.io/guides/data/implement-multitenancy). pgvector discussions note that selective filtering can interact poorly with approximate index scans; 0.8.0 introduced iterative scan options [11](https://github.com/pgvector/pgvector/issues/259). Implication: tenant partitioning and query-plan testing remain necessary even with a post-retrieval safety layer.

### Cache invalidation semantics

Redis `SET ... KEEPTTL` preserves an existing key's TTL and is available since Redis 6.0 [10](https://redis.io/docs/latest/commands/set/). The adapter uses an atomic Lua existence check plus KEEPTTL overwrite so invalidation neither resurrects expired keys nor extends retention. Live tests are provided because fake clients cannot prove server semantics.

### Database isolation and queueing

PostgreSQL RLS requires attention to superuser/BYPASSRLS and owner behavior [3](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). `FOR UPDATE SKIP LOCKED` intentionally provides an inconsistent snapshot of locked rows, which is appropriate for work queues but not for proving a complete inventory by itself. The implementation uses explicit source locks and transactional event/job materialization rather than treating a queue claim as a consistency proof.

## 4. Privacy and governance analysis

GDPR Article 17 is not an unconditional “delete every byte everywhere immediately” command. Grounds, exceptions, controller obligations, and technical feasibility matter; backup and recipient handling need a documented process [2](https://eur-lex.europa.eu/eli/reg/2016/679/art_17/oj). Pseudonymized identifiers can remain personal data when re-identification is possible. Therefore:

- The registry is in scope for privacy review despite storing no document bodies.
- Erasure events delete registered primary derivatives, including memory.
- Legal validation, backups, replicas, downstream recipients, traces, and model weights are explicit external responsibilities.
- Audit retention must balance evidence with minimization.
- Security questionnaire answers should describe implemented controls and coverage, not promise legal compliance.

NIST's GenAI Profile provides a voluntary structure for identifying and managing generative-AI risks [7](https://www.nist.gov/itl/ai-risk-management-framework). It can inform governance and customer questionnaires; it does not certify this implementation.

OWASP LLM08 is cited by its **2025 edition**. Search results may show later renumbering or draft changes; this document does not infer a current ranking from an older edition [1](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/).

## 5. Competitive landscape map

| Category | Examples/prior art | What it addresses | Gap ContextLine must prove |
|---|---|---|---|
| Relationship authorization | OpenFGA, customer auth services | Dynamic checks, contextual relationships | Cross-store derivative registry and verified cleanup evidence |
| Permission-aware RAG | AWS patterns, application middleware | Pre-filtering and serve-time checks | Portable lifecycle propagation beyond one stack |
| Vector stores | Pinecone, pgvector, others | Namespaces, metadata filters, similarity search | Root-version provenance, cache/memory coverage, deletion verification |
| Identity platforms | Okta/Auth0 and peers | Authentication, identity lifecycle | AI derivative inventory and storage actions |
| Data security/governance | Governance/DSPM platforms (capabilities require vendor-specific review) | Discovery, classification, policy | Do not assume they lack AI lineage; validate before claiming differentiation |
| Observability/evals | Tracing/eval tools | Usage and quality evidence | Enforcement and lifecycle mutation, not just visibility |
| Internal tooling | Bespoke pipelines and scripts | Exact customer fit | Integration cost, reliability, auditability, maintainability |

Vendor documentation establishes capabilities, not independent performance or security superiority. No claim is made here about unverified competitor revenue, customer counts, or missing features.

## 6. Customer discovery plan

Target interviews: AI platform leads, security architects, data governance owners, and application engineers at organizations with multiple derivative stores and meaningful permission churn.

Questions:

1. Which AI features read confidential sources today?
2. Where do embeddings, caches, summaries, and agent memories live?
3. How are source permissions represented and how quickly do they change?
4. What happens today when a user leaves a project or a document is deleted?
5. Can you trace a cached answer back to every contributing source?
6. Which serving paths bypass your current authorization checks?
7. How do you verify deletion rather than trusting an API response?
8. What evidence do auditors/customers actually request?
9. What latency budget is available for an authorization check?
10. Can your auth service answer batched source checks?
11. How much provenance can producers preserve without redesign?
12. What is the cost of a false deny versus a false allow?
13. Who owns the dead-letter/review queue?
14. What retention rules apply to audit metadata?
15. Which existing tools already solve part of this?
16. Why have internal scripts not solved it adequately?
17. What would make you reject another infrastructure dependency?
18. Who signs off: security, platform, data, or application owner?
19. What procurement/security review artifacts are mandatory?
20. What measurable outcome would justify a paid pilot?

Score each interview for pain frequency, blast radius, current workaround cost, provenance feasibility, auth API quality, and buying authority. Seek disconfirming evidence: teams may solve this adequately with one vector store, short TTLs, and a single auth middleware.

## 7. Experiments and kill criteria

| Experiment | Success signal | Kill/pivot signal |
|---|---|---|
| Two-week design-partner instrumentation | ≥2 real serving paths governed without producer redesign | Provenance cannot be recovered reliably |
| Revocation drill | Denied on governed paths before cleanup; evidence exportable | Auth callback cannot reflect revocations in acceptable time |
| Mass deletion drill | Verified convergence within agreed objective; dead letters actionable | Connectors cannot verify or fan-out cost is prohibitive |
| Latency test | Meets partner's end-to-end budget with durable audit | Overhead dominates and no safe batching/caching path exists |
| Security review | Questionnaire answered with concrete evidence | Buyers require capabilities outside feasible scope |
| Paid pilot | Budget owner commits after measurable drill | Only abstract interest, no operational owner |

Do not proceed to a hosted control plane until self-managed adoption proves the core loop and operational burden.

## 8. Evidence gaps

- No verified enterprise-adoption barrier ranking or willingness-to-pay survey.
- No independent comparison against commercial governance products.
- No production-scale benchmark, HA failover test, or real customer auth-service integration in this sandbox.
- Redis/pgvector live tests are implemented but were not run locally without those services.
- Docker/CI files exist and remote CI passed on run 42396690030, including live Redis/pgvector and image build; full Compose/runtime qualification remains open.
- Legal analysis is engineering-oriented and requires counsel for a specific deployment.

These gaps are recorded rather than filled with invented numbers. The next research iteration should prioritize interviews and real integration drills over more market-size prose.
