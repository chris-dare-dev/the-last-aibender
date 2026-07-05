# Account-registry generalization — Stage-3 change record ([X1] scalability)

**Status:** record (Stage 3 hardening, 2026-07-05) · **Audience:** engineers +
owner
**Sources of record:** ICR-0013
([../contracts/icr/icr-0013-account-registry.md](../contracts/icr/icr-0013-account-registry.md))
and ICR-0014
([../contracts/icr/icr-0014-fe-account-registry-surface.md](../contracts/icr/icr-0014-fe-account-registry-surface.md));
`docs/contracts/ws-protocol.md` §4.1, `docs/contracts/sqlite-ddl.md` (account-label
section), `docs/contracts/bootstrap-file.md` §2/§3.6/§4.6/§6; SECURITY.md §1 +
`.gitleaks.toml` header ([X2] doctrine). Operator procedure:
[add-an-account.md](add-an-account.md).

This record documents WHAT changed and WHY, states the exact sanctioned FORM,
describes the runtime REGISTRY, and captures the co-sign. It is the single
narrative index for the generalization; the ICRs are the amendment contracts and
`add-an-account.md` is the minimal operator procedure.

---

## The motivation (owner-surfaced)

The owner logged into TWO more Claude Max accounts (labels **MAX_C**, **MAX_D**)
exactly like the three provisioned ones. The Keychain isolation mechanism scaled
automatically — a distinct `CLAUDE_CONFIG_DIR` yields a distinct
`CLAUDE_SECURESTORAGE_CONFIG_DIR` sha256, hence a distinct
`Claude Code-credentials-<hash8>` Keychain item (verified distinct:
max-c=`16aeac00`, max-d=`0b14f259`, both distinct from a/b/ent). But the new
accounts were **invisible to the harness** because the account label set was
hardcoded to exactly `{MAX_A, MAX_B, ENT}` (+ the two backend labels `AWS_DEV`,
`LOCAL`). [X1] asks "is it easy to add a new Claude subscription account?" — the
honest answer was **no**. This change makes it **yes**.

## The design — two concepts, deliberately separated

The old closed 5-set conflated two different things. They are now split:

1. **FIXED BACKEND LABELS** — `AWS_DEV`, `LOCAL`. NOT Claude accounts; each is the
   single stand-in for one backend substrate (`AWS_DEV` → OpenCode→Bedrock,
   `LOCAL` → LM Studio). The set stays **CLOSED**
   (`FIXED_BACKEND_LABELS` / `isFixedBackendLabel`). A new one would be a new
   backend — its own ICR.

2. **CLAUDE ACCOUNT LABELS** — an **OPEN, validated FORM**, because the owner can
   provision arbitrarily many Claude Max subscriptions on one machine:

   ```
   CLAUDE_ACCOUNT_LABEL_RE = /^MAX_[A-Z]$/   (Max accounts, A–Z)
   plus the exact literal 'ENT'              (enterprise / work)
   ```

   So `MAX_A`, `MAX_B`, `MAX_C`, `MAX_D`, … `MAX_Z` are all first-class
   sanctioned placeholders **without a code change**. WIRE and SCHEMA VALIDATION
   accept the form; UI ENUMERATION renders the runtime REGISTRY (never a
   hardcoded count). `ENT` stays a single exact literal (a future `ENT_x` form
   would be its own ICR — kept minimal and [X2]).

`isAccountLabel(v)` = `isClaudeAccountLabel(v) || isFixedBackendLabel(v)` — the
FORM, not a hardcoded 5-set, is the validation ceiling. `LABEL_BACKENDS` (a fixed
`Record`) became **`backendForLabel(label): Backend`** (a function; the DAG's
`ACCOUNT_STEP_BACKENDS` Record likewise became `accountStepBackendsFor(label)` so
it does not return `undefined` for `MAX_C` at runtime). The account↔backend
pairing invariant is preserved verbatim: any `MAX_<X>`/`ENT` → `claude_code`,
`AWS_DEV` → `opencode`, `LOCAL` → `lmstudio`.

## The runtime registry — discovery, not hardcoding

The set of Claude accounts the harness knows about is **discovered** from the
per-account profile manifests under `infra/profiles/*.profile.json` (the SAME
glob + shape the `infra/scripts/accounts/*.sh` tools consume). Adding an account
is a **data** change — drop in its manifest — with zero code change.

- **Broker** (`core/src/kernel/accountRegistry.ts`, `createAccountRegistry`):
  reads each `*.profile.json`, validates `.label` against the FORM (refuses a
  fixed-backend label or a non-sanctioned label fail-closed), enforces the
  securestorage↔config-dir pin, expands the `$AIBENDER_HOME/` convention once
  (NFC, byte-stable — the string the Keychain hash keys off), and refuses a
  duplicate label. `composeBroker` builds it and threads
  `accountRegistry.labels()` into the bootstrap file's optional
  `claudeAccounts: string[]` field (the ICR-0014 carrier; sanitized fail-closed).
- **Cockpit** (`app/src/lib/accountRegistry.ts`): the FE reads `claudeAccounts`
  from the bootstrap once at boot (`setConfiguredClaudeAccounts`), read-side
  FORM-filtered. The launch picker, channel instrument panels, and the
  observability / pipelines / workstreams account chips enumerate the runtime
  registry (N Claude accounts + the two fixed backend labels), never a hardcoded
  five. An empty registry omits the bootstrap field and the FE falls back to its
  seed set.

`ACCOUNT_LABELS` (the old 5-literal frozen array) survives as a KNOWN/SEED list
for back-compat + DB seeding + tests — it is no longer the ceiling.

## Schema (migrations 0005 + 0006)

The account-label CHECK constraints were pinned to the closed 5-literal set.
Migration **0005** (kernel DB: `account_profiles`, `resume_ledger`,
`session_node`, `step_attempt`) and **0006** (events DB: `events`,
`quota_snapshots`, `session_outcomes`) relax them to the FORM:

```
account[_label] GLOB 'MAX_[A-Z]' OR account[_label] IN ('ENT','AWS_DEV','LOCAL')
```

`GLOB 'MAX_[A-Z]'` is the SQL mirror of `^MAX_[A-Z]$` (GLOB treats `_` literally,
`[A-Z]` is a case-sensitive single-char class) — `MAX_C` matches; `MAX_AB`,
`MAX_1`, `max_a`, `HACKER` do not. The label↔backend pairing CHECK is preserved
verbatim (defense-in-depth: a bypassing raw-SQL writer still cannot land an
illegal row). SQLite cannot `ALTER` a CHECK, so each table is rebuilt inside the
migration transaction via `PRAGMA defer_foreign_keys = ON` plus the
rename-old-first recipe for the one inbound-FK table (`session_node` ←
`session_edge`); seed rows + indexes preserved, `foreign_key_check` clean at
COMMIT. Frozen migrations 0001–0004 are untouched.

## [X2] doctrine — the sanctioned MAX_&lt;X&gt; form

SECURITY.md §1 and the `.gitleaks.toml` header generalize the Max-account
placeholder from the two literals `MAX_A`/`MAX_B` to the `MAX_<X>` form. `MAX_C`
and `MAX_D` are now first-class sanctioned placeholders (same class as
`MAX_A`/`MAX_B`) — using them in code, fixtures, and docs is fine. The real
identity mapping stays machine-local (`$AIBENDER_HOME/identity-map.json` /
`@aibender/shared` identity map / the owner's head) and never enters the tree.
**No gitleaks rule changed:** a `MAX_<X>` label is not secret-shaped, verified
against all three Tier-1 rules — `MAX_C`/`MAX_D` trip nothing in Tier-1 or
Tier-2.

## Compatibility

Additive / validation-widening. Every M1–M6 label is still valid; no wire SHAPE
changed (only which `accountLabel`/`account` VALUES validate). Every prior golden
fixture replays byte-identically; the corpus gained valid `MAX_C`/`MAX_D` launch
fixtures + a rejected non-sanctioned fixture (case-sensitivity: lowercase `max_c`
is NOT `MAX_C`). Protocol bumped **`1.4.0` → `1.5.0`**, **`FROZEN-M6` →
`FROZEN-M7`**; the WS/hooks golden corpora advanced to `FROZEN-M7` on both CI
halves. The identifier-audit invariant ("no raw identity can render") is INTACT
and strengthened: a non-sanctioned label is REJECTED at every layer (wire
validator, schema accessor + DDL CHECK, identity-map loader, hook-POST path) and
the registry drops identity-shaped garbage fail-closed, for any N.

## Co-sign record (ICR-0013 / ICR-0014)

- **ICR-0013** (AMENDS FROZEN-M1-CORE `vocab.ts`): **BE-ORCH RATIFIED
  2026-07-05; FE-ORCH co-signed 2026-07-05.**
- **ICR-0014** (FE bootstrap `claudeAccounts` carrier): **BE-ORCH RATIFIED
  2026-07-05; FE-ORCH co-signed 2026-07-05.**

Both rows are recorded in `docs/contracts/icr/README.md` (rows 54–55).

## Proof (N-account extensibility, end-to-end synthetic)

Every DoD item has a runnable proof (fixtures/temp dirs only — never the real
`~/.aibender/accounts/*`):

- **Form accepts MAX_C/MAX_D, rejects non-sanctioned** — protocol
  `packages/protocol/src/vocab.spec.ts` (accepts every `MAX_<A-Z>` + `ENT`;
  rejects `HACKER`, `MAX_AB`, `MAX_1`, `max_a`, `ENT_X`, …); schema
  `packages/schema/src/kernel.spec.ts` (MAX_C admitted; `HACKER` refused at the
  accessor AND at the DDL CHECK when bypassed) + `events.spec.ts` (a raw-SQL
  identity-bearing account is refused by the label-enum CHECK).
- **4th/5th account drives registry → kernel spawn → launch, no code change** —
  `core/src/kernel/accountRegistryLaunch.spec.ts` (MAX_C is the 4th account,
  MAX_D the 5th; correct per-account `CLAUDE_CONFIG_DIR` /
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `OTEL_RESOURCE_ATTRIBUTES=account=MAX_C`;
  unconfigured/non-sanctioned/wrong-backend rejected). Over the composed broker:
  `core/src/main/index.spec.ts` (a FOURTH account discovered from a fixture
  profiles dir launches over `composeBroker`; the discovered registry flows into
  the bootstrap `claudeAccounts` advertisement).
- **FE picker + panels render N accounts; identifier audit intact** —
  `app/src/features/launch/{audit,views}.spec.ts`,
  `app/src/lib/accountRegistry.spec.ts`, `app/src/chrome/InstrumentStack.spec.tsx`,
  the observability/pipelines/workstreams `audit.spec.tsx` (5-Claude registry
  renders MAX_C/MAX_D as sanctioned placeholders across the full state matrix;
  registry drops email/12-digit/token/`HACKER` fail-closed).
- **provision --dry-run PLANs all 5; lib.sh resolves a max-c manifest** —
  `infra/scripts/tests/accounts.bats` (--dry-run plans MAX_C/MAX_D; a synthetic
  MAX_E manifest resolves end-to-end with no code change; hermetic
  `AIBENDER_HOME` temp dir).

## Pending-owner (handled by the owner / driving session — do NOT touch)

- The real `~/.aibender/accounts/{max-c,max-d}` dir markers, `0700` perms, and
  their real `claude /login`s are owner-run T3 steps (see
  [add-an-account.md](add-an-account.md) §2–4). The generalization is proven
  synthetically; the real logins remain the owner's.
- The pre-existing [X2] git-history rewrite of the root commit's work-email author
  field (and the subsequent push) stays owner-gated — the 12 Tier-2 `.git/logs`
  reflog echoes are a consequence of that un-rewritten history, not of this
  change (no tracked/working-tree file leaks).
