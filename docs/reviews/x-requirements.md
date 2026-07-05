# Stage-3 Review — Cross-Cutting Requirements ([X1]/[X2]/[X3]/[X4])

Adversarial pass against the four cross-cutting requirements of the
architecture blueprint: [X1] parallel multi-account, [X2] secret hygiene,
[X3] conditional virtualization + LM-Studio-always-connects, [X4] workstreams.
Read-only against `HEAD = 0abf45f`.

**Dimension survivors:** 4 (2 medium, 2 low). Two are true findings (X2 audit
coverage, X4 merge-brief enforcement); two are **verification-passed controls**
recorded here as evidence that the guard works — no fix required, but listed so
the fix-team does not re-open them.

---

## Findings requiring a fix

### X-1 (MEDIUM · partial) — [X4] merge action can record a merge without the mandatory conflict-surfacing brief

- **Anchor:** `core/src/workstreams/recorder.ts:220-248` (merge case);
  port type `packages/protocol/src/workstreams.ts:504`
  (`LineageMergeAction.briefId?`)
- **Failure scenario:** Blueprint §5 declares a merge is a *synthesis* seeded by
  a schema'd, conflict-surfacing merge brief ("merge = synthesis, not
  concatenation"). The **client wire** contract enforces this: `ws-protocol.md
  §16.2` marks `briefBody` **required** on `workstream-merge-request`. But the
  **kernel-facing recording port** allows `briefId` optional
  (`workstreams.ts:504`), and `recorder.ts:220-248` (the already-materialized-
  node path) validates parent + toSessionId node existence but **never**
  requires `briefId` — line 241 conditionally includes it
  (`...(action.briefId !== undefined ? { briefId: action.briefId } : {})`).
  `recorder.spec.ts:118` confirms a merge records successfully with no briefId,
  creating merge edges without the brief. The engine.ts path always synthesizes
  a brief first (so it is safe today), but a future or external caller into
  `recorder.record({ kind: 'merge', ..., briefId: undefined })` would create a
  merge node with no conflict narrative. The UI renders the merge as complete;
  stakeholders never see the surfaced conflicts.
- **Recommendation:** Close the asymmetry between the wire contract (briefBody
  required) and the recording port (briefId optional). Either (a) make `briefId`
  required for `kind:'merge'` in the port type, or (b) add a runtime guard in
  `recorder.ts`'s merge case that throws when a merge action lacks a briefId.
  Add a negative test asserting merge-without-briefId is rejected.
- **Verifier:** **partial → confirmed asymmetry.** Read all four surfaces: port
  type optional (workstreams.ts:504); recorder merge case does not require it
  (220-248, line 241); spec proves record-without-brief (118); wire contract
  requires briefBody (ws-protocol.md §16.2); blueprint §5 declares the brief
  mandatory. engine.ts always passes a briefId (current guard), but the
  recorder path allows undefined. Severity MEDIUM (not low): a growing code path
  or external API call violates a blueprint invariant and yields a
  conflict-blind merge in the UI.

### X-2 (MEDIUM · partial) — [X2] identity-audit sweep enumerates sources from a hardcoded list, not the protocol's `EVENT_SOURCES`

- **Anchor:** `core/src/collector/x2Audit.spec.ts` (source list ~lines 320-329);
  protocol `EVENT_SOURCES` (`packages/protocol/src/...`, ~lines 41-62)
- **Failure scenario:** The X2 audit test comprehensively sweeps every column of
  every row for identity shapes (email/AWS-ID/token) across the eight
  implemented sources and asserts a backstop that the store rejects
  identity-bearing inserts. But the sweep iterates a **hardcoded** list of
  expected sources rather than dynamically deriving it from the protocol's
  `EVENT_SOURCES` constant. If a developer adds a new source to `EVENT_SOURCES`,
  implements it, but forgets to add it to the test's list, the sweep never sees
  that source's rows — the audit silently under-covers. (The real per-source
  enforcement is the scrub-at-ingest call plus the schema's
  `assertIdentityFreeColumn` insert backstop, so a new source is not
  *unprotected* — but the automated sweep that would catch a *missing* scrub call
  would not run for it.)
- **Recommendation:** Derive the audited source list from `EVENT_SOURCES` at
  test time (iterate the constant), and assert that every implemented source is
  covered — failing loudly if a source is defined but unswept. Keep the
  per-source scrub + schema backstop as the primary gate; the sweep is
  defense-in-depth and should not be able to fall out of sync silently.
- **Verifier:** **partial.** The sweep does cover all eight implemented sources
  and validates the backstop. But it uses a hardcoded source list (not
  `EVENT_SOURCES`), so a newly added source could escape the sweep. The primary
  enforcement is per-source scrub + `assertIdentityFreeColumn`, not the sweep
  itself — so this is a coverage-drift gap in defense-in-depth, MEDIUM.

---

## Verification-passed controls (no fix — recorded as evidence)

### X-3 (LOW · confirmed) — [X1] multi-account isolation: env-var scrub discipline is correctly enforced under SDK spawn

- **Anchor:** `core/src/kernel/env.ts:30-39` + `core/src/kernel/sessionKernel.spec.ts:111-131`
- **Assessed scenario:** Injected `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
  / `ANTHROPIC_PROFILE` / `CLAUDE_CODE_USE_*` in the base env would hijack
  another account's credential scope during a parallel launch.
- **Verifier: confirmed PASS.** `env.ts:30-40` scrubs all listed vars +
  prefixes; `buildSessionEnv` skips them and returns `Object.freeze(env)`;
  `sessionKernel.ts:336` builds the env before the ledger row insert at :339
  (row-before-spawn); `sessionKernel.spec.ts:111-131` proves the hijack vars are
  absent from `spec.env`; `:133-160` proves the ledger row is in `spawning`
  state when `runner.start` fires; `DoubleResumeError` (`:506-509`, `:560-568`)
  blocks unforked resume of live sessions. The scenario is impossible: scrub is
  pre-spawn, the env is frozen, no post-scrub mutation path exists. No finding.
- **Note:** the evolutionary risk that a *new* SDK credential var could bypass
  the exact-name scrub is captured separately as **SEC-5** in `security.md`.

### X-4 (LOW · confirmed) — [X3] architectural boundary: `core/` adapters cannot import from `infra/` / k8s / colima

- **Anchor:** `core/src/adapters/opencode/serve.spec.ts:402-420`
- **Assessed scenario:** A future maintainer adds a Colima/k3s/kubernetes import
  to an adapter (e.g. for remote model loading), silently making the harness
  require k3s and violating the [X3] "LM Studio is host-native" verdict.
- **Verifier: confirmed PASS.** The test recursively scans all `.ts` under
  `core/src/adapters/` and asserts zero imports matching
  `/(kubernetes|k8s|colima|infra\/)/`. It runs on every test execution and is
  green. Grep confirms no such imports exist. References to
  `infra/profiles/*.profile.json` in `profiles.ts`, `main/index.ts`, and
  `gateway/bootstrap.ts` are **data-file** references, not code imports. The
  guard is live and would catch the violation immediately. No finding.
