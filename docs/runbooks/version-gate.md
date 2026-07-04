# Runbook — version gate: mandatory checks before any Claude Code / SDK bump

**Status:** live (M1, SI-2) · **Audience:** owner (T3 steps are owner-run, never headless)
**Script:** `infra/scripts/accounts/version-gate.sh`
**Sources of record:** blueprint §3 rule 4, plan §6/SI-2 + §10 risk row
("Keychain scoping changes in an SDK bump"),
[x1-parallel-multi-account](../research/findings/x1-parallel-multi-account.md).

## Why this gate exists

The per-account keychain isolation that [X1] stands on is **undocumented
upstream**: with `CLAUDE_SECURESTORAGE_CONFIG_DIR` set, the credentials item is

```
service = "Claude Code" + OAUTH_FILE_SUFFIX + "-credentials"
          + "-" + first 8 hex of sha256( NFC(dir string) )      # raw string, not resolved path
account = $USER
```

(verified in the shipping binary v2.1.193 by read-only `strings` inspection,
2026-07-04 — the deobfuscated function is quoted in
[infra/profiles/README.md](../../infra/profiles/README.md)). Anthropic already
moved credential storage once (2025 file→Keychain migration) and introduced
this suffixing quietly in the 2.1.x line. Any SDK/CLI bump can therefore
silently change the derivation and "log out" all three accounts — the CLI
would compute different service names and find empty keychain slots.

**No SDK/CLI version bump lands without this runbook passing. The pinned
version holds until it does.**

## The gate procedure

### 0. One-time baseline (after certifying the current pin)

```sh
infra/scripts/accounts/version-gate.sh --init
```

Writes `$AIBENDER_HOME/state/version-gate.json` (0600): per-label expected
service names, the service base, and the CLI version string. Run `--init` only
on a version you have fully certified (steps 1–5 below green).

### 1. Pre-bump sanity — the gate must PASS on the current pin

```sh
infra/scripts/accounts/version-gate.sh
```

The script (a) recomputes the expected service name per account manifest,
(b) diffs against the baseline state file, (c) runs
`keychain-probe.sh` (presence only, **never `-w`**), and prints
`RESULT: PASS` or `RESULT: BLOCK`. A pre-bump BLOCK means your environment
drifted — fix that before even considering a bump.

### 2. Bump in a sandbox, not in place

Install the candidate CLI/SDK version somewhere that does not replace the
pinned binary the broker uses (e.g. `npm install` into a scratch prefix, or a
second Homebrew cellar). Do not roll the broker's pin yet.

### 3. Re-run the gate against the candidate

```sh
infra/scripts/accounts/version-gate.sh
```

- `gate ... MISMATCH` → our recompute drifted vs baseline (config/manifest/
  base change on our side). Resolve before blaming the SDK.
- `probe ... MISSING` after re-login attempts with the candidate → the
  candidate likely changed the derivation. **BLOCK.**
- `probe ... DRIFT` → byte-stability violation (marker vs recompute). Fix the
  dir strings; never re-login around it.

If the candidate changed the **base** service name (not the hash), the scripts
take `--service-base` / `AIBENDER_KEYCHAIN_SERVICE_BASE` — recompute with the
new base, and treat it as a derivation change: ADR + re-baseline required.

### 4. T3 value-access proof (owner-run)

Presence is necessary, not sufficient. Prove the broker's own context can read
values, per account, with the **candidate** binary:

```sh
AIB="$HOME/.aibender"
CLAUDE_CONFIG_DIR="$AIB/accounts/max-a" CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-a" claude auth status --json
CLAUDE_CONFIG_DIR="$AIB/accounts/max-b" CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-b" claude auth status --json
CLAUDE_CONFIG_DIR="$AIB/accounts/ent"   CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/ent"   claude auth status --json
```

All three must parse as authenticated with zero interactive prompts. Any
re-login prompt on a bump = **BLOCK**.

### 5. Setup-token keychain-DELETION canary (T3, owner-run — NEVER headless)

Issue-#37512 class: historically, a process exiting while authenticated via
`CLAUDE_CODE_OAUTH_TOKEN` could **delete** the keychain credentials entry.
This canary is mandatory **before rung 2 is ever enabled** on a candidate
version, and again on every subsequent bump while rung 2 is in use.

It deliberately risks destroying a credential, which is why it is owner-run
against a scratch profile and must never be scripted into CI or any headless
automation path:

1. **Scratch profile, not a real account.** Create and log a throwaway session
   into a scratch dir (mirror of §3 in
   [login-bootstrap.md](login-bootstrap.md), with
   `$AIB/accounts/canary` as both env vars — provision the dir by hand;
   the canary label is deliberately absent from the committed manifests).
2. Record presence: `keychain-probe.sh` semantics by hand —
   `security find-generic-password -a "$USER" -s "Claude Code-credentials-<hash8-of-canary-dir>"`
   (no `-w`). Item present.
3. Generate a setup-token for the scratch profile (`claude setup-token` with
   the canary env block).
4. Run one headless prompt through the candidate binary with the token:

   ```sh
   CLAUDE_CODE_OAUTH_TOKEN="<canary token>" \
   CLAUDE_CONFIG_DIR="$AIB/accounts/canary" \
   CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/canary" \
   claude -p 'Reply with the single word: ok'
   ```

   Let it exit normally.
5. Re-probe step 2. The keychain item **must still be present**, and
   `claude auth status --json` for the canary dir must still show the OAuth
   login.
6. Item vanished or auth broken → **BLOCK**: the #37512 class is back. Hold
   the pin, disable/keep-disabled rung 2, file an ADR, report upstream.
7. Clean up: delete the canary keychain items and the scratch dir
   (`security delete-generic-password -s <canary services>` — canary only,
   never a real account's item), revoke the canary token if the account UI
   allows it.

### 6. Certify and re-baseline

Only after 1–5 are green:

```sh
# roll the pin (install channel of record), then:
infra/scripts/accounts/version-gate.sh --init   # refresh the baseline against the new version
infra/scripts/accounts/version-gate.sh          # must print RESULT: PASS
```

Record the bump (old → new version) in the commit that changes the pin.

## On BLOCK

1. **Hold the pinned SDK.** The pin is the mitigation; nothing else changes.
2. Diagnose which invariant broke (base name, hash input, hash width, storage
   location, #37512 behavior).
3. Consult the [X1] fallback ladder (blueprint §3): rung 2 (setup-token per
   process) is the designed fallback if config-dir keychain scoping regresses
   — but rung 2 itself is gated on the §5 canary.
4. File an ADR in `docs/adr/` before any deviation from the blueprint
   mechanism.

## State file

`$AIBENDER_HOME/state/version-gate.json` (0600, machine-local, never
committed):

```json
{
  "schemaVersion": 1,
  "baselineAt": "<UTC timestamp>",
  "serviceBase": "Claude Code-credentials",
  "claudeVersion": "<claude --version at --init time, or \"unknown\">",
  "accounts": [
    { "label": "MAX_A", "dir": "<byte-stable dir string>", "service": "Claude Code-credentials-<hash8>" }
  ]
}
```

## Script reference

```
version-gate.sh [--dry-run] [--init] [--aibender-home DIR]
                [--profiles-dir DIR] [--service-base NAME] [--state-file F]
```

- `--dry-run` — recompute + baseline diff only; no keychain probe, no writes.
  A dry-run PASS is advisory, never a certification.
- Exit codes: `0` PASS / init ok · `1` BLOCK or error.
- What the script deliberately does **not** do: §4 (auth status) and §5
  (canary) are T3 owner-run and stay out of every automated path
  (plan §9.4). The script only prints reminders for them.

## CI/test coverage

`pnpm run test:infra` exercises the gate headlessly (temp `$AIBENDER_HOME`,
stubbed `security`, `--dry-run`): baseline-missing BLOCK, simulated
hash-suffix drift BLOCK, missing-item BLOCK, and the PASS path — plus the
static assertion that no script ever passes `-w` to `security`
(plan §9.2 SI-2 row).
