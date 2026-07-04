# docs/adr/ — architecture decision records (deviation ledger)

The [architecture blueprint](../research/summaries/01-architecture-blueprint.md)
is **normative**. Deviating from it without an ADR here is a review reject
(plan §1.1). Where the implementation plan and the blueprint disagree, the
blueprint wins — the ADR records why we still deviated.

**Naming:** `NNNN-<slug>.md`, zero-padded, monotonically increasing.
**Length:** one page. If it needs more, the decision is not crisp yet.

**Template** (plan §1.1 item 4 — all four sections are mandatory):

```markdown
# ADR-NNNN — <decision, stated as a verb phrase>

- Date: YYYY-MM-DD
- Author: <orchestrator id — BE-ORCH / FE-ORCH / SI-ORCH>
- Status: proposed | accepted | superseded by ADR-NNNN

## Context
<the forces at play; what made the blueprint's answer not hold>

## Decision
<what we are doing instead, precisely>

## Blueprint section overridden
<§n of 01-architecture-blueprint.md, quoted — or "none: gap, not override">

## Consequence
<what gets easier, what gets harder, what must be revisited and when>
```

ADRs are also required for any frontend dependency not on the locked exact-pin
table (plan §5) and for observability fallbacks (plan §10).

Status: **M0 — no ADRs yet.** Numbering starts at `0001`.
