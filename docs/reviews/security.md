# Stage-3 Review — Security & [X2] Secret Hygiene

Adversarial principal-engineer review, deepest pass. Read-only against
`HEAD = 0abf45f` (protocol 1.5.0 / FROZEN-M7, schema migration 0006).

**Dimension survivors:** 8 (2 high, 2 medium, 4 low). Findings ranked
most-severe first. Every finding carries the independent verifier's
confirm/partial verdict and reasoning. Identities appear only by placeholder
label ([X2]); no real identifier is reproduced anywhere in this doc.

---

## Git-history secret-leak scan (independent re-run)

I re-ran BOTH gitleaks tiers myself over the full repository. `gitleaks 8.30.1`.

| Scan | Scope | Bytes | Result |
|---|---|---|---|
| Tier-1 `gitleaks git .` | 59 commits (committed history) | 6.98 MB | **clean — no leaks** |
| Tier-2 `gitleaks git .` | 59 commits (committed history) | 6.98 MB | **clean — no leaks** |
| Tier-1 `gitleaks dir .` | working tree + `.git` + node_modules | 11.86 MB | **clean — no leaks** |
| Tier-2 `gitleaks dir .` | working tree + `.git` + node_modules | 1.08 GB | **12 findings — all `.git/logs` reflog echoes (known-pending-owner)** |

**Verdict on the 12:** confirmed to be exactly the known class and nothing
new. All 12 are located under `.git/logs` (6× `.git/logs/HEAD`,
4× `.git/logs/refs/heads/main`, 2× `.git/logs/refs/remotes/origin/main`),
rule classes `work-domain-literal` / `work-domain-email-literal`. They are
historical commit-message **subject lines** echoed into the local reflog. The
committed object history is clean on both tiers (the `gitleaks git` scans that
walk commit blobs/trees find nothing), so nothing leaked is or ever was
pushed. The reflog is local-only and self-prunes on `git gc` / reflog expiry;
clearing it early is an owner action (history/reflog hygiene is owner-gated in
this program). **No new leak of any class was found anywhere.**

> Note the tier/scope interaction for future reviewers: the pre-commit hook and
> CI run `gitleaks git --pre-commit` (staged/committed content only), which is
> why these echoes never block a commit. They surface only in a full-tree
> `gitleaks dir` walk that descends into `.git/logs`.

---

## Findings

### SEC-1 (HIGH · confirmed) — Bootstrap file removal is not re-validated before unlink (TOCTOU)

- **Anchor:** `core/src/gateway/bootstrap.ts:240-252` (`removeBootstrapFile`)
- **Failure scenario:** `removeBootstrapFile` reads + token-checks the file
  (`readBootstrapFile` → `current.token !== expectedToken` guard), then
  unconditionally `rm(bootstrapPath())`. Between the check and the unlink,
  Boot B can write a fresh bootstrap file with its own token to the same path.
  The `rm()` then deletes **Boot B's** newer discovery file, not the stale
  Boot A file the guard validated. This violates bootstrap-file.md §3.4:
  "A stale broker exiting late can therefore never delete a newer boot's
  discovery file." The catch-all `catch { return false }` additionally masks
  the difference between ENOENT (benign, already gone) and a real failure.
- **Recommendation:** Make removal an atomic check-then-unlink. Prefer
  re-reading + re-validating the token immediately before unlink, or gate the
  unlink on the file still carrying `expectedToken` (e.g. read-validate-unlink
  as tightly as the FS allows, or a rename-to-marker sequence). Treat ENOENT
  as idempotent success; log a warning when the token no longer matches at
  unlink time (indicates a concurrent newer boot). Add a two-broker race test
  proving only the newer file survives.
- **Verifier:** **confirmed.** Reviewed the actual code. Read+check at
  244-245, unconditional unlink at 247, catch-all at 249-250. The gap where
  Boot B can write a same-path file with a different token is real and violates
  the ownership-checked-removal contract (§3.4).

### SEC-2 (HIGH · confirmed) — Line scrubber's identity map is never wired into the gateway logger

- **Anchor:** `core/src/gateway/server.ts:270` (scrubber construction);
  capability proven but unused at `packages/shared/src/redaction.spec.ts:99-146`
- **Failure scenario:** `startGateway` builds its scrubber with
  `createLineScrubber({ secretValues: [token] })` — **only** the per-boot
  token, **no `identityMap`**. `createLineScrubber` (redaction.ts:78) only
  installs identity patterns when `options.identityMap` is provided; with it
  undefined, account emails are never scrubbed from log lines. `loadIdentityMap`
  exists (`identityMap.ts`) but is called only in tests, never in gateway
  startup. Consequences: (1) account emails from the identity map appear in
  plaintext logs; (2) newly provisioned accounts (MAX_C, MAX_D, …) are not
  protected; (3) rotated secondary emails are not protected. This is an [X2]
  defense that is present in the library but not connected — a wiring gap, not
  a design flaw.
- **Recommendation:** Load the identity map at gateway boot and pass it into
  `createLineScrubber({ secretValues: [token], identityMap })`. Because SEC's
  X2 posture is account-aware, also make the map reloadable when the account
  registry changes (same trigger that re-syncs the FE registry — see
  FE-1/frontend-correctness). Add a gateway-level test that a log line
  containing a mapped email is redacted.
- **Verifier:** **confirmed.** server.ts:270 passes only `secretValues:[token]`
  and no identityMap; redaction.ts:78 only builds identity patterns when the
  map is present; `loadIdentityMap` is test-only. The spec at
  redaction.spec.ts:102-146 proves the capability works **when wired** — it is
  not wired. Severity HIGH ([X2] defense incomplete).

### SEC-3 (MEDIUM · partial) — Hooks endpoint loopback-binds correctly but has no per-boot authentication (local-process spoofing)

- **Anchor:** `core/src/collector/hooks/server.ts:63` (`HOOKS_SERVER_HOST`)
- **Failure scenario:** The hooks server binds `127.0.0.1:4319` correctly, so
  the *network-exposure* half of the original finding is refuted — an IPv4
  loopback socket cannot receive traffic from external networks or 0.0.0.0
  regardless of firewall state. **However**, any other local process (a
  malicious npm dependency, a browser extension, a compromised sibling
  process) can reach `127.0.0.1:4319` and POST crafted hook payloads. The
  endpoint authenticates only by account-label path segment
  (`validateHookPost(segment, body)`) — there is no per-boot HMAC/token header.
  A local attacker can inject false `PermissionRequest` / `SessionEnd` /
  `PreCompact` events into the approval floor and session ledger, corrupting
  decision-making and lineage integrity.
- **Recommendation:** Add per-boot token/HMAC authentication to the hooks
  endpoint (distinct from the WS gateway token; injected into each account's
  hook settings at install time). Keep the loopback bind. Document in
  hooks-contract.md §4 that hooks are internal-only. Verify in the SI-3 bats
  suite that the socket is unreachable from 0.0.0.0. **Drop the firewall
  aspect of the recommendation — it is not the threat model.**
- **Verifier:** **partial.** The finding conflates firewall misconfiguration
  (refuted — loopback bind is correct, validated at hooks.spec.ts:64-66 and
  documented at hooks-contract.md §1) with local-process spoofing (confirmed —
  no header auth, only account-label validation). Real gap; threat model is
  local-only, not network; severity is if anything understated because a local
  process can poison the approval/lineage layer.

### SEC-4 (MEDIUM · partial) — Gitleaks Tier-2 config permission is checked for existence but not for `chmod 600`

- **Anchor:** `SECURITY.md §2` / the installed pre-commit hook
  (`infra/scripts/install-hooks.sh`)
- **Failure scenario:** The pre-commit hook fails closed on a *missing* Tier-2
  file (`[ -f "$TIER2_CONFIG" ]`) but does **not** validate its permissions. An
  operator who creates the private config under a permissive umask ends up with
  a world-readable file holding exact private literals, and the gate never
  complains. (The CI-bypass and umask-doc angles of the original finding are
  refuted: SECURITY.md §2 documents Tier-2 as private/out-of-repo/never-in-CI by
  design, and `gitleaks.yml` correctly runs Tier-1 only.)
- **Recommendation:** Add a permission assertion to the hook before running
  Tier-2, e.g. fail closed unless `stat -f '%A'` on the Tier-2 config is `600`.
  Document the required `umask 0077` in hygiene.md. This is defense-in-depth for
  the file that, by design, holds the one thing that must never be exposed.
- **Verifier:** **partial.** Read the installed hook, SECURITY.md §2, and
  hygiene.md. The hook checks existence but not `chmod 600` — the
  permission-validation gap is genuine and worth fixing. The CI concern is
  refuted by design. The `--no-verify` bypass is real but inherent to the
  "agents as commit authors" model. Core gap valid; severity slightly
  overstated in the original.

### SEC-5 (LOW · partial) — Env-injection scrub relies on exact name / prefix matching; a new SDK credential var could pass through

- **Anchor:** `core/src/kernel/env.ts:30-39` (`SCRUBBED_ENV_VARS` /
  `SCRUBBED_ENV_PREFIXES`); tested at `core/src/kernel/env.spec.ts:33-51`
- **Failure scenario:** `buildSessionEnv` scrubs a hardcoded set
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`,
  prefix `CLAUDE_CODE_USE_*`) plus an explicit refusal for
  `CLAUDE_CODE_OAUTH_TOKEN`. If a future Claude SDK introduces a new
  credential-bearing var (e.g. `CLAUDE_CODE_OAUTH_PROVIDER_TOKEN`,
  `CLAUDE_CODE_BEDROCK_SECRET_KEY`), it silently passes through into child
  processes: there is no secret-shaped-name pattern match, no fail-close on
  unknown `CLAUDE_CODE_*`, and no per-SDK-bump review gate. Mitigating: the
  built env is `Object.freeze`'d and fully replaces the child env, so there is
  no post-build injection vector.
- **Recommendation:** Add a secret-shaped-name pattern fail-close: refuse the
  spawn (typed error) for any inbound var starting `ANTHROPIC_`/`CLAUDE_` or
  containing `TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL` that is not on an explicit
  permit list. Alternatively invert to an allowlist of permitted vars. Add a
  check-at-SDK-bump note to the release procedure.
- **Verifier:** **partial (plausible, partially confirmed).** Confirmed the
  scrub is hardcoded exact-match + one prefix + one explicit refusal, with no
  secret-shaped pattern and no auto-update per SDK bump. The env is frozen and
  replaces the child env (mitigating). The gap is evolutionary risk, not
  current active exposure — LOW.

### SEC-6 (LOW · partial) — opencode.db guard is table-name exclusion, not field-level DDL tagging

- **Anchor:** `core/src/adapters/opencode/dbAccess.ts` (guard) /
  `dbAccess.spec.ts:108-120`
- **Failure scenario:** The guard blocks reads of the `credential` / `account`
  tables by name matching over all SQL forms. If **OpenCode itself** (external
  dependency) renames those tables in a future version, the name-based guard
  becomes ineffective. The harness cannot add tables to opencode.db (it opens
  it read-only), so the risk is external-schema-drift, not harness schema
  migration.
- **Recommendation:** Document the frozen/external-schema assumption in
  dbAccess.ts's header and treat any OpenCode version bump as requiring
  re-validation of the guard's table names during SDK integration testing.
  Consider field-level tagging (mark credential/token columns protected) as a
  post-M7 hardening.
- **Verifier:** **partial.** Correctly identifies name-exclusion vs field-level
  tagging. The failure scenario is mis-scoped to "harness schema migrations"
  when the real constraint is an external OpenCode rename. The guard is adequate
  for FROZEN-M7 (read-only OS-level open, only BE-4/BE-5 readers, all via
  guarded `select()`). Valid as a post-M7 observer note. LOW.

### SEC-7 (LOW · partial) — opencode.db guard does not defend against a view/alias created by a separate write-capable process

- **Anchor:** `core/src/adapters/opencode/dbAccess.ts` /
  `dbAccess.spec.ts:88-91`
- **Failure scenario:** The guard strips comments/literals and blocks direct
  `SELECT ... FROM credential|account` across quoted/backticked/bracketed/
  schema-qualified forms. But if a **separate process with OS-level write
  access** creates `CREATE VIEW credential_alias AS SELECT secret FROM
  credential`, a later `SELECT ... FROM credential_alias` would not be blocked —
  the guard is a negative blocklist over known table names, not a
  runtime-schema allowlist. The connection is opened `readOnly: true`
  (node:sqlite), which prevents writes on *this* connection but not schema
  mutation by another process. The test suite does not cover CREATE VIEW bypass
  or Unicode-normalization tricks. Prerequisite: OS-level write access to the
  db file (a pre-existing breach).
- **Recommendation:** (1) Document the OS-level read-only assumption for
  opencode.db in SECURITY.md §3 and/or the dbAccess.ts header — enforce it via
  file permissions, not just code logic. (2) Consider a positive allowlist of
  permitted tables/views (`event`, `migration`, `event_sequence`) validated
  against the live schema at runtime. (3) Add guard tests for view/alias and
  Unicode-normalization bypass.
- **Verifier:** **partial.** The direct-table guard works across all SQL forms.
  The CREATE VIEW bypass is technically possible only given OS-level write
  access; the operational design treats opencode.db as an imported read-only
  artifact. SECURITY.md does not currently state the OS-level read-only
  requirement explicitly. LOW (OS-access prerequisite).

### SEC-8 (LOW · confirmed) — Bootstrap `claudeAccounts` sanitization runs on both write and read (intentional, no change needed)

- **Anchor:** `core/src/gateway/bootstrap.ts:139-152` and
  `app/src/lib/bootstrap.ts:137-144`
- **Failure scenario (assessed):** A corrupted/hand-tampered bootstrap file
  could contain non-form account labels (real emails, fixed backend labels).
  The BE write sanitizes via `sanitizeClaudeAccountsForBootstrap` before persist
  (bootstrap.ts:178) and the BE read re-sanitizes (226-231); the FE read filters
  again via `isClaudeAccountLabel` (bootstrap.ts:143). The FE re-validation is
  redundant relative to the BE write — but by design.
- **Recommendation:** No code change. This is mandated defense-in-depth per
  bootstrap-file.md §4.6 ([X2] fail-closed). The BE write is the enforcement
  point; the FE re-validation is a fail-closed safety net for unmapped/tampered
  files. Worth a one-line comment stating that explicitly.
- **Verifier:** **confirmed.** Read both implementations and the contract. The
  redundancy is intentional, both layers are safe, non-form entries silently
  drop, and it matches bootstrap-file.md §4.6. Documentation-only. LOW.

---

## Cross-references

- SEC-2 (identity-map wiring) and the FE-side registry re-sync (FE-1 in
  `frontend-correctness.md`) share a root trigger: both should re-run on the
  `onBrokerRestart` / boot-identity-change event. Fixing them together is
  cheaper than separately.
- SEC-1 (bootstrap removal TOCTOU) and the FE bootstrap-carrier findings
  (FE-1, FE-4) all touch the same bootstrap-file lifecycle; the fix-team should
  read bootstrap-file.md §3–§4 once and address them as a cluster.
