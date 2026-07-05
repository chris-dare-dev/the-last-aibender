# Stage-3 Review — Frontend & Protocol Correctness (source-level)

Adversarial source-level pass over the cockpit FE and its protocol handling.
Read-only against `HEAD = 0abf45f`. **This is not the rendered-screen-capture
review** — that is a separate pass, pending a live app (see
`docs/reviews/README.md`).

**Dimension survivors:** 4 (1 high, 3 low). The high finding is a real
[X1] multi-account regression on broker restart.

---

## Findings

### FE-1 (HIGH · confirmed) — Configured Claude accounts live in a module closure and are not re-synced on broker restart

- **Anchor:** `app/src/main.tsx:84-97` (`configureAccountRegistry`, called once);
  closure at `app/src/lib/accountRegistry.ts:201`; missing re-sync in
  `app/src/features/.../bind.ts:57-68` (`onBrokerRestart` handler)
- **Failure scenario:** `setConfiguredClaudeAccounts()` is called exactly once
  at the composition root, storing the advertised list in a module-level closure
  variable (`accountRegistry.ts:201`). The `onBrokerRestart()` handler
  (`bind.ts:57-68`) resets all stores and watermarks but **never** re-reads the
  bootstrap file or re-calls `setConfiguredClaudeAccounts()`. The broker-restart
  trigger is correctly detected (`wsClient.ts:294-296`, boot-identity mismatch)
  and emitted, but no FE listener acts on it to re-sync the registry. So: broker
  boots with MAX_C provisioned → updates `bootstrap.claudeAccounts` to
  `[MAX_A, MAX_B, ENT, MAX_C]` → broker restarts → FE keeps rendering the stale
  seed `[MAX_A, MAX_B, ENT]`; MAX_C is invisible in every account surface
  (picker, channel panels, observability chips, pipelines, workstreams — all
  read `accountRegistry()` → `buildAccountRegistry(configuredClaudeAccounts)`,
  the stale value) until a manual page reload. This breaks [X1] multi-account
  extensibility and silently loses an account (violating fail-closed
  discipline — the account should never silently disappear from the operator's
  view).
- **Recommendation:** Store the configured Claude accounts in a reactive store
  (approvalsStore or a dedicated config store), not a module closure. Subscribe
  to `client.onBrokerRestart()` and re-read the bootstrap carrier to re-sync the
  registry on boot-identity change (the same event that resets watermarks).
  Pairs with **SEC-2** in `security.md` — both should re-run on the same
  restart trigger.
- **Verifier:** **confirmed.** Traced the full flow: single call at
  main.tsx:88 → closure at accountRegistry.ts:201; `onBrokerRestart` in
  bind.ts:57-68 resets stores but never re-syncs the registry; trigger detected
  at wsClient.ts:294-296 but no listener acts; all account surfaces read the
  stale closure value. Realistic failure scenario confirmed. Correct fix:
  reactive store + re-sync on `onBrokerRestart`.

### FE-2 (LOW · confirmed) — Approval decision can race with the broker-pushed `approval-resolved` (UX stutter, duplicate send)

- **Anchor:** `app/src/chrome/ApprovalInbox.tsx:50-58` +
  `app/src/lib/stores/approvalsStore.ts:44-71`
- **Failure scenario:** `ApprovalInbox.decide()` calls
  `client.sendApprovalDecision()` fire-and-forget (`wsClient.ts:452-454`, no
  await/ack) without disabling the button or setting any in-flight state. The
  store tracks only `pending` and `resolved` — no intermediate `deciding` state.
  Between the send and the `approval-resolved` fan-out arriving, the row is
  still visible and clickable. A second click sends a duplicate decision on a
  now-in-flight approval. The broker rejects it idempotently
  (`gateway/server.ts:581-591`, `outcome === 'not-pending'`), so no corruption
  — but the user sees a visible stutter / can double-fire.
- **Recommendation:** Add a `deciding` state to the store, set on `decide()`
  before sending, cleared on `approval-resolved`. Filter `pendingApprovals()` to
  hide (or disable) any approval whose id is in the `deciding` set. This
  prevents both the stutter and the duplicate send.
- **Verifier:** **confirmed.** `decide()` (ApprovalInbox.tsx:50-59) has no state
  mgmt / button disable; store (44-71) has only pending/resolved;
  `sendApprovalDecision` is fire-and-forget (wsClient.ts:452-454); broker
  rejects duplicates idempotently (server.ts:581-591). Race is real; broker
  rejects cleanly → LOW; the `deciding`-state fix is sound.

### FE-3 (LOW · partial) — Opaque (unknown-kind) workstream payloads are correctly filtered but dropped with zero operator visibility

- **Anchor:** validator `packages/protocol/src/validate.ts:1947-1978`
  (`validateWorkstreamServerPayload`); reader filter
  `app/src/features/workstreams/bind.ts:43-60` (drop at line 58); store default
  case `app/src/features/workstreams/store.ts:245-248`
- **Failure scenario:** The original worry — that an unknown-kind payload from a
  newer broker reaches the store/UI and degrades a feature by losing metadata —
  is **refuted**: the forward-tolerant reader rule is implemented as a
  reader-side filter (`bind.ts:58` `if ('opaque' in payload) return;`) *before*
  the store projector, and the store's default case is documented as
  "opaque payloads are filtered upstream." So opaque payloads never reach the
  UI. **However**, the drop is completely silent: an M5 broker sending a new
  `lineage-advisory-v2` kind to an M4 client produces zero operator visibility
  into the schema drift — no log, no status indicator. `app/src/lib/log.ts`
  exists and supports debug/warn, but is not called here.
- **Recommendation:** Log dropped opaque kinds at DEBUG (or surface a count in
  the chrome/status view) so an operator can detect protocol drift. Document the
  forward-tolerance guarantee explicitly in the contract. Correctness is fine;
  this is an observability gap.
- **Verifier:** **partial.** The metadata-loss/feature-degradation scenario is
  blocked by the reader-side filter (confirmed by reading validate.ts:1947-1978,
  bind.ts:43-60, store.ts:245-248). The observability concern is valid — no log
  on drop, no operator visibility into drift. Gap is observability, not
  correctness → LOW.

### FE-4 (LOW · confirmed) — Malformed / torn-write bootstrap file falls closed to the seed registry with no operator log

- **Anchor:** `app/src/lib/bootstrap.ts:58-83` (`isGatewayBootstrap`),
  `:114-124` (`discoverGateway`), `:137-144`
  (`configuredClaudeAccountsFromBootstrap`); consumed at `app/src/main.tsx:84-97`
- **Failure scenario:** A bootstrap write interrupted mid-flush leaves partial
  JSON. `isGatewayBootstrap` returns false → `discoverGateway` returns undefined
  → `configuredClaudeAccountsFromBootstrap` returns `[]` → `main.tsx:87`
  `advertised.length > 0` is false → `setConfiguredClaudeAccounts` is **not**
  called → the registry stays at the seed three (`accountRegistry.ts:201`). This
  is fail-closed by design, but there is **no** `console.log/info/warn`
  indicating the fallback occurred or why (absent file / unparseable / empty
  array / all non-form labels dropped), so if the owner later repairs the file
  the cockpit still shows the seed three until a manual reload, with no signal
  that anything was wrong.
- **Recommendation:** In `configureAccountRegistry()`, log an info/warn when the
  advertised list is empty, with the reason (absent / unparseable / empty /
  all-dropped). Surface it in startup logs or a status line. (Compounds with
  FE-1: once the registry is reactive and re-syncs on restart, a repaired file
  would self-heal; until then, at least tell the operator.)
- **Verifier:** **confirmed.** Read all cited paths: torn file → validation
  false (58-83) → undefined (123) → `[]` (142) → `main.tsx:87` skips
  `setConfiguredClaudeAccounts` → seed fallback (accountRegistry.ts:201), and
  main.tsx:84-97 has no log statements. Works as designed (fail-closed);
  logging the fallback reason is the valid fix. UX/observability, not
  correctness/security → LOW.

---

## Cross-references

- **FE-1** and **FE-4** are the same lifecycle bug family (bootstrap-carrier →
  account registry) seen from two angles: FE-1 is "no re-sync on restart", FE-4
  is "silent fallback with no log". A reactive config store subscribed to
  `onBrokerRestart` + a fallback-reason log addresses both, and pairs with
  **SEC-2** (identity-map wiring on the same restart trigger).
