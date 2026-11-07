# ContextLine documentation

**Source-aware access control for AI-generated data.** This is a working, local-first reference implementation, not a hosted enterprise service or a compliance certification.

## Start here

1. [Quickstart](quickstart.md) — install, run the interactive demo, and reproduce the revocation scenario.
2. [Architecture](architecture.md) — the three capabilities, trust boundaries, and request/event sequences.
3. [Security model](security.md) — precise guarantees, defaults, isolation, and failure behavior.
4. [SDK and API reference](api.md) — complete integration examples and error semantics.
5. [Deployment](deployment.md) — PostgreSQL roles, worker configuration, containers, and production checklist.

## Blueprint record

- [Blueprint (Revised)](blueprint/blueprint-revised.md): the authoritative specification supplied by the project owner, with [provenance and precedence](blueprint/README.md) for all three passes.
- [Blueprint conflicts](blueprint-conflicts.md): every disagreement between the three passes, the chosen behavior, and why.
- [Conformance matrix](conformance.md): 96 requirements tracked as met / partial / deviation / deferred, each with evidence.

## Engineering reference

- [Requirements and scope](requirements.md): implementation status and normalized traceability for the supplied brief's 30 themes.
- [Registry schema](schema.md): tables, keys, indexes, versions, RLS, and migration policy.
- [Connector contract](connectors.md): PostgreSQL, pgvector, Redis, verification, and custom adapters.
- [Operations runbook](operations.md): monitoring, retries, dead letters, review queues, backup/restore, and incidents.
- [Incremental adoption](adoption.md): instrument ingestion, retrieval, caches, events, and memory without a big-bang migration.
- [Threat model](threat-model.md): assets, attackers, abuse cases, mitigations, and explicit residual risks.
- [Testing and validation](testing.md): reproducible test suites and adversarial cases.
- [Validation results](validation.md): what was actually executed and measured in this repository.
- [Benchmark report](benchmark-1m.json): the 1M-row / 50-tenant run behind the latency gates.
- [Architecture decisions](decisions.md): why the implementation differs from the initial draft where necessary.
- [Roadmap](roadmap.md): production gaps, prioritized experiments, and acceptance criteria.
- [Changelog](changelog.md) and [third-party notices](third-party.md).

## Research and product record

- [Research and evidence ledger](research.md): primary-source findings, supported claims, corrections, and open questions.
- [Research audit](research-audit.md): claim-by-claim verification of the three-topic report supplied on 2026-11-07, with the [verbatim artifact](external/2026-11-07-three-topic-research-report.md). Not a product specification.
- [Product strategy](product-strategy.md): problem, market hypotheses, competition, pricing experiments, GTM, risks, and founding-team needs.
- [Interactive demo guide](demo.md): every control and the underlying implementation.

## Reading paths

**Application engineer:** Quickstart → API → Adoption → Connectors.  
**Security reviewer:** Security → Threat model → Schema → Operations → Validation.  
**Operator:** Deployment → Operations → Testing → Connectors.  
**Founder/product lead:** Research → Product strategy → Requirements → Roadmap.

All examples use synthetic identifiers and data. Never put credentials, document content, prompts, or embeddings into registry identifiers or connector configuration.
