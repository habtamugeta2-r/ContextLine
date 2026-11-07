# Blueprint record

On 2026-11-07 the project owner supplied three successive versions of the ContextLine engineering blueprint in a single message:

| Version | Title | Treatment in this repository |
|---|---|---|
| **A — Revised** | "Engineering Research and End-to-End Implementation Blueprint" (Part 0–7, items marked *Revised*) | **Authoritative.** Reproduced in full in [blueprint-revised.md](blueprint-revised.md). The owner states these are decisions changed or added on this pass. |
| **B** | "Deep Engineering Research & End-to-End Implementation Blueprint" (seven traps, Parts 1–7) | Earlier pass. Restates A with different mechanics in several places. Consequential differences captured as quoted deltas in [../blueprint-conflicts.md](../blueprint-conflicts.md). |
| **C** | "Deep Implementation Blueprint" (Phase 0–7, task-level) | Earliest/most granular pass. Useful task decomposition; several behaviors are superseded or unsafe. Differences captured in [../blueprint-conflicts.md](../blueprint-conflicts.md). |

## Precedence rule used by this implementation

1. **A (Revised) wins** wherever the three disagree, because the owner explicitly marked it as the corrected pass.
2. Where A is silent, **B** is used, then **C**.
3. Where any version conflicts with a **security invariant already proven by tests**, the invariant wins and the conflict is recorded with a rationale rather than silently ignored. Two examples: artifact resurrection on re-registration (C), and superuser runtime roles (C).
4. Where a version states an **unverified absolute** (latency, "not a data processor", compliance), the claim is recorded as a target/hypothesis and the measured or legally qualified position is documented instead.

Every conflict, the chosen behavior, and its rationale is listed in [../blueprint-conflicts.md](../blueprint-conflicts.md). Implementation status against each Part is tracked in [../conformance.md](../conformance.md). Decision records live in [../decisions.md](../decisions.md).

## Why A is authoritative in one paragraph

A fixes three things the later-numbered documents get wrong or leave ambiguous: it separates principal-scoped revocation from source-wide events (so one user's offboarding cannot delete everyone's answers), it requires register-before-write with a revocation race check, and it caps and constrains the optional auth cache instead of treating caching as free. Those are exactly the decisions that change the security outcome, so they take precedence over the older mechanical descriptions.
