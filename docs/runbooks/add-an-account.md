# Runbook — add a new Claude subscription account

**Status:** live (Stage 3, SI) · **Audience:** owner (the login step is T3, owner-run, never headless)
**Sources of record:** blueprint §3 ([X1] mechanism), ICR-0013
([docs/contracts/icr/icr-0013-account-registry.md](../contracts/icr/icr-0013-account-registry.md)),
[infra/profiles/README.md](../../infra/profiles/README.md) (form + derivation +
expansion rules), [login-bootstrap.md](login-bootstrap.md) (the one-time login
flow this runbook reuses).

This is the **[X1] scalability answer made concrete**: "is it easy to add a new
Claude subscription account?" — **yes**. Adding one is a *manifest-only* change
(no code edit anywhere), one interactive login, and one probe. The keychain
isolation scales automatically — a distinct `CLAUDE_CONFIG_DIR` yields a
distinct securestorage sha256, hence a distinct Keychain item — so N accounts
run concurrently with zero cross-talk and zero re-login.

The label set is an **open, validated form**, not a closed list:

- a **Max** account is `MAX_` + one uppercase letter A–Z (`^MAX_[A-Z]$`) —
  `MAX_C`, `MAX_D`, … `MAX_Z` are all valid **without a code change**;
- the **enterprise** account is the single literal `ENT`.

The fixed backend labels `AWS_DEV` / `LOCAL` are **not** Claude accounts and have
no profile manifest — do not add one for them.

[X2] reminder: labels are placeholders **only**. The real identity for a new
label lives machine-locally in `$AIBENDER_HOME/identity-map.json` and your head —
never in a manifest, this runbook, an issue, or a transcript. Pick the next free
`MAX_<X>` letter; the letter is not the account.

---

## The whole procedure (≈5 minutes, once per account per machine)

### 1. Write the manifest (the only file you add)

Pick the next free letter — say `MAX_E` — and its lower-case dir stem `max-e`.
Clone an existing Max manifest and change exactly the label + the three path
strings:

```sh
cd infra/profiles
jq '.label = "MAX_E"
    | .pathConvention = "$AIBENDER_HOME/accounts/max-e"
    | .env.CLAUDE_CONFIG_DIR = "$AIBENDER_HOME/accounts/max-e"
    | .env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "$AIBENDER_HOME/accounts/max-e"
    | .keychain.setupTokenItemConvention = "aibender-setup-token-max-e"' \
  max-a.profile.json > max-e.profile.json
```

Invariants the scripts enforce for you (all in `infra/scripts/accounts/lib.sh`):

- **Label form.** A label outside `^MAX_[A-Z]$` / `ENT` is refused with an
  `aib_die` — a typo or an accidental [X2] leak never resolves.
- **Securestorage pin.** `CLAUDE_SECURESTORAGE_CONFIG_DIR` **must** equal
  `CLAUDE_CONFIG_DIR` (byte-for-byte). Provisioning refuses a manifest where
  they differ (blueprint §3).
- **Convention prefix.** Both env strings must begin `$AIBENDER_HOME/` — the
  literal `$AIBENDER_HOME` is the expansion token, not a shell variable.

No script, schema, UI, or test hardcodes the count — everything enumerates the
`*.profile.json` glob and validates the form, so the new manifest is picked up
the moment it exists.

### 2. Provision the dir

```sh
infra/scripts/accounts/provision-accounts.sh --dry-run   # confirm MAX_E is PLAN-CREATED
infra/scripts/accounts/provision-accounts.sh             # create the 0700 dir + marker
```

The dry-run prints one `provision  MAX_E  <dir>  PLAN-CREATED` line among the
existing accounts and mutates nothing. The real run creates
`$AIBENDER_HOME/accounts/max-e/` (0700) with a provenance marker recording the
**byte-stable** dir string, and is a no-op (`OK`) for every already-provisioned
account. It **refuses** to touch a populated dir it did not provision.

### 3. One interactive login (T3, owner-run)

Identical to [login-bootstrap.md §3](login-bootstrap.md) — the env block is the
byte-stable contract; use exactly the strings provisioning printed:

```sh
AIB="$HOME/.aibender"    # the SAME absolute AIBENDER_HOME provisioning used

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_PROFILE -u CLAUDE_CODE_OAUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$AIB/accounts/max-e" \
  CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-e" \
  claude
#   → /login → complete the browser OAuth hop with the account you map to MAX_E
#   → /exit once authenticated
```

Run from a normal **Aqua (GUI) terminal** — the login keychain must be unlocked;
never over SSH ([#44089] class). This login is once per account per machine.

### 4. Probe (presence, never `-w`) and re-baseline the version gate

```sh
infra/scripts/accounts/keychain-probe.sh                 # MAX_E → PRESENT, distinct hash8
infra/scripts/accounts/version-gate.sh --init            # re-certify the baseline WITH MAX_E
```

`keychain-probe.sh` recomputes the expected `Claude Code-credentials-<hash8>`
service name for every account and reports `PRESENT` — a new, distinct hash for
`MAX_E`. It never reads a credential value. Prove value access separately, in the
broker's own context, exactly as in [login-bootstrap.md §4b](login-bootstrap.md#4-verify-probe--presence-then-prove-value-access):

```sh
CLAUDE_CONFIG_DIR="$AIB/accounts/max-e" CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-e" \
  claude auth status --json
```

Then re-run `version-gate.sh --init` so the certified baseline includes `MAX_E`
(otherwise the next gate run would flag it as "absent from the baseline" and
`BLOCK`). Re-baseline **only after** a green probe + the T3 checks above.

### Done

The new account is now a first-class member of the registry: it enumerates in
provisioning, probing, and the version gate; the harness's UI renders it from the
discovered registry (never a hardcoded count); and it launches concurrently
alongside the others. No code was changed — you added one JSON file and logged
in once.

---

## Removing an account

Delete the manifest, remove `$AIBENDER_HOME/accounts/<stem>/` yourself (the
scripts never delete a config dir — a live credential store must never be
clobbered), delete the machine-local `identity-map.json` entry, and re-run
`version-gate.sh --init` to drop it from the baseline. The Keychain item is the
owner's to remove via Keychain Access; harness scripts never write or delete
credential items.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `provision`/`probe` `aib_die`s "not a sanctioned Claude-account placeholder" | Label is not `MAX_<X>`/`ENT` (typo, extra letter, lower-case, an identity leak) | Fix `.label` to a single-uppercase-letter `MAX_<X>` or `ENT`. Never encode a real identity — that is the [X2] gate doing its job |
| `provision` REFUSED | Dir populated but not harness-provisioned | See [login-bootstrap.md §8](login-bootstrap.md#8-troubleshooting) |
| Probe `MISSING` for the new label | `/login` never completed for that dir, or a byte drift in the dir string | Re-run §3; a `DRIFT` line means restore the exact original string (never re-login to "fix" byte drift) |
| Version gate says the new label is "absent from the baseline" | You provisioned + logged in but did not re-`--init` | Re-run `version-gate.sh --init` after a green probe |

## T3 pending-owner checklist (real host, real account)

- [ ] Manifest written (`infra/profiles/max-<x>.profile.json`), form + pin valid
- [ ] `provision-accounts.sh` real run creates the 0700 dir + marker
- [ ] One interactive login (§3) from an Aqua session
- [ ] `keychain-probe.sh` → new label `PRESENT`, distinct `hash8`
- [ ] `claude auth status --json` parses authenticated for the new account
- [ ] `version-gate.sh --init` re-baselined with the new label present
