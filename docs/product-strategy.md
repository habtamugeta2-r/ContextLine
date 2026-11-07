# Product strategy record

**Status:** hypotheses and a build/learning plan, not validated market facts. The accompanying [research ledger](research.md) records evidence and corrections. No customers, revenue, or partnerships are claimed.

## 1. Vision and wedge

Vision: make source permission boundaries survive the transformation of documents into AI derivatives.

Initial wedge: **a self-managed SDK + PostgreSQL registry + worker for teams that already have multiple AI stores and a batch-capable authoritative authorization service.** The first sellable outcome is a reproducible revocation/deletion drill with evidence, not a broad “AI security platform.”

The product combines three capabilities that are often owned by different teams:

1. Root-source dependency registration across embeddings, caches, summaries, and memories.
2. Serve-time authorization using the customer's existing checker.
3. Verified asynchronous lifecycle propagation with durable audit evidence.

The differentiator must be demonstrated against adjacent authorization, RAG, vector-store, and governance tools. “No one else does this” is not a positioning claim.

## 2. Ideal customer profile (hypothesis)

Stronger fit:

- Multiple derivative stores or frameworks; meaningful cache/memory persistence.
- Confidential sources with frequent project membership, ACL, retention, or deletion changes.
- Existing authoritative authorization API and platform engineering capacity.
- Security/audit pressure with a named operational owner.
- Willingness to instrument producers and serving paths.

Weaker fit:

- One vector store, short-lived caches, simple permissions, and adequate existing middleware.
- No recoverable source provenance.
- No batch authorization API and strict sub-millisecond budget.
- Expectation that a metadata layer solves prompt injection, model unlearning, or all backup erasure.
- Desire for a fully hosted product before self-managed value is proven.

## 3. Packaging strategy

Start with an open-core/self-managed developer experience:

- **Open source core:** SDK, registry, worker, basic connectors, demo, docs, tests.
- **Future commercial value:** qualified connector packs, policy rollout analytics, coverage reporting, HA operations tooling, enterprise support, and eventually a hosted control plane.
- Do not paywall the fundamental fail-closed behavior or basic audit evidence needed to evaluate safety.

The current repository implements the open-core technical foundation. Billing, license enforcement, SaaS tenancy, SSO, and a hosted control plane are not built.

## 4. Pricing hypotheses

These are discovery anchors, not published prices or willingness-to-pay evidence:

| Package | Hypothesis | Value metric to test |
|---|---|---|
| Developer | Free self-managed core | Adoption and integration completion |
| Team pilot | Fixed-scope paid drill + support | Number of governed applications/stores |
| Enterprise | Annual support/connector/operations agreement | Governed artifacts, tenants, or workloads—test which is least distortionary |
| Future hosted | Control-plane subscription + usage | Avoid charging per authorization check until cost/value is understood |

Per-check pricing can discourage the very enforcement behavior the product promotes. Per-artifact pricing can penalize chunking. Validate cost drivers and buyer fairness before choosing a meter.

## 5. Market sizing discipline

Do not publish the draft's TAM/SAM/SOM as facts. A transparent scenario model is acceptable only with labeled assumptions:

```text
TAM scenario = qualified organizations worldwide × annual contract value
SAM scenario = reachable organizations in target segments/regions × ACV
SOM scenario = realistically winnable customers over a defined period × ACV
```

Example purely illustrative arithmetic: 22,000 qualified organizations × $25,000 ACV = $550M scenario TAM; 5,000 reachable × $25,000 = $125M SAM; 200–500 customers × $25,000 = $5–12.5M SOM. **The organization counts and ACV are unverified assumptions, not research findings.** Replace them with sourced segment counts and interview/pilot evidence before external use.

Corporate identity/infrastructure transactions are strategic context, not comparable revenue evidence for this product. HashiCorp was acquired by IBM rather than remaining a standalone public comparator.

## 6. Go-to-market motion

1. Publish the reproducible revocation demo and honest security model.
2. Recruit design partners with real permission churn and multiple stores.
3. Run a two-week instrumentation + revocation/deletion drill.
4. Produce a coverage/evidence report the partner can use in security review.
5. Convert to paid support/pilot only after measurable operational value.
6. Expand connectors and automation based on repeated partner needs, not a checkbox list.

Channels to test: security/platform engineering content, open-source integration examples, vector/auth ecosystem partnerships, and direct design-partner outreach. Avoid fear-based claims that regulation mandates this exact architecture.

## 7. North-star and guardrail metrics

North-star candidate: **percentage of identified governed AI serving paths with complete provenance and successful current-source authorization evidence.**

Supporting metrics:

- Time from authoritative revocation to denied governed retrieval.
- Time from source deletion to verified primary-store convergence.
- Unknown-provenance rate and backfill completion.
- Dead-letter/review queue age and operator resolution time.
- False-deny rate and authorization latency distribution.
- Connector verification failures and coverage by store.
- Audit durability failures and registry/auth availability.

Guardrails: no invented compliance certification, no universal leak-proof claim, no unmeasured latency SLA, no counting skipped live tests as passes.

## 8. Moat hypotheses

Potential durability comes from integration depth, connector qualification, operational evidence, and trustworthy failure semantics—not from the idea of a dependency table alone. Open-source adoption can reduce integration friction; commercial value may come from reducing the operational burden across heterogeneous stores.

Risks to the moat: vector/auth platforms add equivalent lifecycle features; governance vendors already cover the workflow; customers prefer internal scripts; provenance instrumentation is too costly; audit/latency overhead is unacceptable.

## 9. Ninety-day learning plan

### Days 1–30: prove the core loop
- Run the demo and tests with design partners.
- Integrate one real auth callback and two real stores.
- Measure end-to-end latency and revocation drills.
- Complete connector live qualification and container/CI execution.

### Days 31–60: prove operational fit
- Backfill a bounded real corpus with quarantine telemetry.
- Exercise worker crash/reclaim, storage outage, and backup-restore replay.
- Answer a real security questionnaire with evidence.
- Identify the smallest useful control-plane surface.

### Days 61–90: prove buying intent
- Convert at least one design partner to a paid pilot or record why not.
- Decide pricing metric from cost/value evidence.
- Prioritize connector/HA work from repeated blockers.
- Publish corrected positioning and measured results.

## 10. Decision gates

Proceed to hosted control plane only if self-managed partners repeatedly need centralized configuration/coverage and will pay for it. Proceed to broad connector expansion only if live qualification and operational ownership are sustainable. Stop or narrow the product if provenance cannot be recovered, existing tools adequately solve the workflow, or no budget owner emerges.

The repository's roadmap is deliberately gated by evidence rather than a promise to ship every item in the original brief.

## 11. Founding-team capabilities (hypothesis)

The work likely requires: a distributed-systems/TypeScript engineer comfortable with PostgreSQL transactions and failure modes; a security/privacy-oriented product engineer who can run design-partner drills and answer questionnaires honestly; and connector/integration expertise across vector stores, caches, and identity systems. Early on these may be two or three people rather than separate departments. Sales motion should be technical and evidence-led until a repeatable pilot exists. This is a staffing hypothesis, not a claim about current headcount or hires.
