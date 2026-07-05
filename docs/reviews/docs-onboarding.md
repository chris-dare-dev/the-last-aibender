# Stage-3 Review — Documentation & New-Engineer Onboarding

Adversarial review of the docs surface a fresh engineer (or a build agent)
would traverse. Read-only against `HEAD = 0abf45f`.

**Dimension survivors:** 8 (1 high, 3 medium, 4 low). All confirmed by the
independent verifier. These are onboarding/discoverability gaps, not
correctness or security defects — but the HIGH one (no local-dev-start
runbook) is a real cold-start cliff.

---

## Findings

### DOC-1 (HIGH · confirmed) — No single "run the app locally end-to-end" instruction set

- **Anchor:** repo root / `docs/runbooks/` (the missing file)
- **Failure scenario:** A new engineer reads `README.md` then `docs/HANDOFF.md`
  and finds architecture, milestones, and test commands — but **no** unified
  document answering "how do I actually start the aibender-core daemon and the
  Tauri app locally and see it working?" `README.md` (lines 73-82) covers
  install/test only; `HANDOFF.md` points to `login-bootstrap.md` for *real*
  owner-gated logins, not a synthetic cold-start dev loop. The steps exist but
  are scattered across `app/README.md`, `app/src-tauri/README.md`, and the
  `m*-dod.md` gate records; the engineer has to reverse-engineer the sequence.
- **Recommendation:** Add `docs/runbooks/local-dev-start.md` (peer to
  `login-bootstrap.md`, `version-gate.md`) documenting the developer loop:
  (1) `pnpm install`; (2) start the broker daemon; (3) start the Tauri dev app
  (`pnpm -F aibender-app tauri dev`); (4) verify WS connection + bootstrap-file
  discovery; (5) how to point at fake/synthetic backends when real logins are
  not done; (6) common dev-mode failures. Link it from `app/README.md`,
  `README.md` "Getting started", and the top of `HANDOFF.md`.
- **Verifier:** **confirmed.** README lines 73-82 are install/test only;
  HANDOFF mentions tauri dev / aibender-core only in passing; app READMEs are
  reference-format, not step-by-step; no `local-dev-start.md` exists;
  `docs/runbooks/README.md` lists 21 runbooks, none covering cold-start dev.
  Exact match to the failure scenario.

### DOC-2 (MEDIUM · confirmed) — No "how to read a frozen contract" orientation for new implementers

- **Anchor:** `docs/contracts/README.md`
- **Failure scenario:** The contracts README explains the freeze table and each
  contract's status but not the **relationship** between the prose contract
  (e.g. `ws-protocol.md`) and its machine-checkable half in
  `packages/{protocol,schema}`, nor the role of `packages/testkit` golden
  corpora as proof of conformance. An implementer tasked with "land the BE-8 DAG
  schema" reads `dag-schema.md`, sees "the machine-checkable half lives in
  packages/protocol", and burns time hunting for where it actually is instead
  of going straight to the types + golden fixtures.
- **Recommendation:** Add a §0 "How to read these contracts" to
  `docs/contracts/README.md`: (1) prose is normative for decisions and
  cross-department coordination; (2) `packages/{protocol,schema}` is the
  authority for validation/serialization; (3) disagreement → file an ICR;
  (4) `packages/testkit` golden corpus is the proof of conformance; (5) a worked
  example, e.g. `ws-protocol.md §2 (Envelope) → packages/protocol/src/envelope.ts
  → packages/testkit/corpus-ws-*.ts`.
- **Verifier:** **confirmed.** README (37 lines) states prose-is-record on
  disagreement (lines 7-10) and individual contracts reinforce it, but there is
  no central §0 explaining the three-way prose/code/testkit relationship or a
  worked example, and testkit's role is unmentioned.

### DOC-3 (MEDIUM · confirmed) — DESIGN.md lock rule states the rule but not the reason, at the point of need

- **Anchor:** `README.md` (implicit) / `DESIGN.md:1-23`
- **Failure scenario:** A backend engineer reads DESIGN.md's amendment rule
  ("any change requires an ADR plus FE-ORCH sign-off") and sees the doc is
  "injected into every build agent's context" (line 16), but the **causal
  reason** — uncoordinated token changes break agent-driven-build determinism —
  lives only in the blueprint (§8, line ~357), not in DESIGN.md at the point of
  need. The BE dev could attempt a small uncoordinated token change (a new
  backend-status color) and hit a confusing review rejection.
- **Recommendation:** Add one sentence to DESIGN.md near the lock notice: "The
  lock exists because this token set is injected into every agent's context
  during FE builds — uncoordinated changes break agent determinism. Treat tokens
  as a frozen contract; propose changes via ICR/ADR."
- **Verifier:** **confirmed.** DESIGN.md states the injection fact (line 16) but
  not the determinism consequence; the normative "why" is only in blueprint §8.
  The failure scenario is plausible; the one-sentence fix addresses it.

### DOC-4 (MEDIUM · confirmed) — Protocol version numbering / freeze cadence is not documented for maintainers

- **Anchor:** `docs/contracts/ws-protocol.md:1-40` + `packages/protocol/src/index.ts`
- **Failure scenario:** An implementer finishing a feature must decide whether
  to bump `PROTOCOL_VERSION` and by how much (1.4.0 → 1.4.1 vs 1.5.0). The rule
  — validation-WIDENING / additive surfaces → minor; backward-incompatible SHAPE
  change → major; clarification → patch — exists **only** as inline TSDoc
  examples in `index.ts` (lines ~1-159) and in the ws-protocol.md freeze
  headers. There is no canonical named-principle document, so the rule must be
  inferred from past freeze examples.
- **Recommendation:** Add a versioning section to `docs/contracts/README.md` (or
  a `docs/contracts/versioning.md`) stating the semver rule as a principle:
  major = shape change; minor = validation-widening / additive; patch =
  clarification; `FROZEN-M<n>` tag cadence; every freeze is tagged and recorded
  in prose; with the M7 worked example (account-label widening → minor
  1.4.0→1.5.0).
- **Verifier:** **confirmed.** The rule is stated only via inline examples in
  `index.ts` and freeze headers; no standalone maintainer doc exists; the ICR
  README assumes the versioner already knows the rule. Information is correct but
  scattered and example-based, not centralized.

### DOC-5 (LOW · confirmed) — Directory structure / ownership is condensed in README, full map only in the plan

- **Anchor:** `README.md:59-72` (Repository layout)
- **Failure scenario:** To find where [X4] workstream code lives, which runbook
  documents the account registry, or where a new feature belongs, an engineer
  bounces between the terse README list, the dense plan §2 table
  (`02-stage2-implementation-plan.md`), and `docs/runbooks/README.md`. `core/`
  has no README (unlike `app/` and `infra/`), and `packages/*` have none.
- **Recommendation:** Expand README "Repository layout" with a purpose column
  anchored to the owning lane/department, and/or add a one-line top-of-README
  blurb to each major directory (`core/`, `app/`, `infra/`, `packages/*`) —
  `core/` most notably lacks one.
- **Verifier:** **confirmed.** README layout table (59-72) is condensed; `core/`
  lacks a README (filesystem-confirmed); `app/`/`infra/` have detailed ones;
  `packages/*` have none; README already cites the responsible department and
  links the plan. Onboarding friction, not a correctness gap → LOW.

### DOC-6 (LOW · confirmed) — "How to add a new Claude account" is documented but not discoverable from README/HANDOFF

- **Anchor:** `docs/runbooks/add-an-account.md` (exists, good); the gap is the
  missing forward references
- **Failure scenario:** `HANDOFF.md §1` and `SECURITY.md §1` both say the owner
  may provision arbitrarily many Max accounts (`MAX_<X>`) with no code change,
  but neither links to `add-an-account.md`, and `README.md` getting-started does
  not mention provisioning. An engineer asking "how do I add MAX_C?" has to
  discover the runbook by scanning the full index or grepping.
- **Recommendation:** Add a one-line forward reference in `HANDOFF.md §1` after
  the account-placeholders paragraph and a cross-link in `SECURITY.md §1` near
  the `MAX_<X>` form definition, both pointing at `add-an-account.md` ("no code
  change required").
- **Verifier:** **confirmed.** `add-an-account.md` exists and is comprehensive;
  HANDOFF §1 and SECURITY §1 describe the open form but do not link it; README
  getting-started omits it; the M7 record references it only historically.
  Discoverability gap, docs-only → LOW.

### DOC-7 (LOW · confirmed) — The multi-agent build workflow doc is linked late / not prominent

- **Anchor:** `docs/HANDOFF.md:7-9` (forward link) →
  `docs/runbooks/workflow-orchestration.md` (the doc)
- **Failure scenario:** HANDOFF's "Companion doc — read it second" line sits in
  the preamble before the numbered TL;DR. A reader who scans §0 (TL;DR), jumps
  to §3 (Status) then §9.1 (next action) can miss it and start work without the
  orchestration-pattern context. The doc lives in `docs/runbooks/`, not
  `docs/` top level, so it is not obvious on a quick repo scan.
- **Recommendation:** No code change required. Make the "Companion doc" line
  bold/unmissable in HANDOFF §0, and/or add a breadcrumb in README
  "Getting started" pointing multi-agent-build collaborators at
  `workflow-orchestration.md`.
- **Verifier:** **confirmed.** The reference is present at HANDOFF lines 8-10
  (preamble) and §8 references it clearly for linear readers, but a jumping
  reader can miss it; the file is under `docs/runbooks/`; README has no
  secondary breadcrumb. Confirmed for partial/jumping readers, mitigated for
  careful linear ones → LOW.

### DOC-8 (LOW · confirmed) — The M7 / ICR-0013 account-registry fix is understated in HANDOFF (reads as cosmetic, was a breaking fix)

- **Anchor:** `docs/HANDOFF.md §3` M7 row; details live in
  `docs/runbooks/account-registry.md` + `ICR-0013`
- **Failure scenario:** The HANDOFF §3 M7 row says the hardcoded 3-label
  registry "couldn't see" MAX_C/MAX_D — implying invisibility, not failure. In
  M6, `isAccountLabel()` was a hardcoded membership check against the 5-literal
  array and schema CHECK constraints pinned the same 5 values, so a MAX_C/MAX_D
  launch would have **failed validation** at multiple layers. M7 relaxed
  `isAccountLabel()` to `^MAX_[A-Z]$` + `ENT` and relaxed schema CHECKs to the
  GLOB form. A new engineer reading the current wording would not grasp that M7
  fixed a breaking [X1] scalability bug that made the owner's 5th account
  non-functional.
- **Recommendation:** Expand the HANDOFF §3 M7 row to flag it as a CRITICAL FIX
  (closed 5-label set → open `MAX_<X>` form, newly provisioned accounts work
  without code change, landed immediately after M6 when the 5th account failed),
  linking `account-registry.md` and `ICR-0013`.
- **Verifier:** **confirmed.** Cross-checked M6 (5864cff) vs M7 (e5ae65f): M6
  `isAccountLabel()` was hardcoded membership + schema CHECK pinned to 5 values;
  MAX_C/MAX_D would have failed at the wire check, the schema CHECK, and any
  label-validating path. M7 relaxed both. HANDOFF's "couldn't see" understates a
  breaking fix; `account-registry.md` captures it but HANDOFF §3 should surface
  the criticality. Docs-only → LOW.
