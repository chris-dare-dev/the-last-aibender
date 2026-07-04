# Runbook — login bootstrap: one interactive login per account, ever

**Status:** live (M1, SI-2) · **Audience:** owner (T3 steps are owner-run, never headless)
**Sources of record:** blueprint §3 ([X1]), plan §6/SI-2,
[x1-parallel-multi-account](../research/findings/x1-parallel-multi-account.md),
[infra/profiles/README.md](../../infra/profiles/README.md) (derivation + expansion rules).

Each of **MAX_A / MAX_B / ENT** gets its own config dir with
`CLAUDE_SECURESTORAGE_CONFIG_DIR` pinned to the same path, which yields a
distinct macOS Keychain item per account. You log in interactively **once per
account per machine**; thereafter every session of every account runs
concurrently with zero re-login.

[X2] reminder: this file and every committed file use placeholder labels only.
The real account mapping lives in `$AIBENDER_HOME/identity-map.json` and your
head — never in the tree, an issue, or a transcript.

---

## 1. Provision the account dirs

```sh
infra/scripts/accounts/provision-accounts.sh --dry-run   # inspect the plan
infra/scripts/accounts/provision-accounts.sh             # create the dirs (0700)
```

Creates `$AIBENDER_HOME/accounts/{max-a,max-b,ent}/` (default
`~/.aibender/accounts/...`) with a provenance marker recording the
**byte-stable dir string**. The script refuses to touch a populated dir it did
not provision — see §7 if that happens.

## 2. Pre-flight: env hygiene (blueprint §3 rule 3)

Auth precedence can hijack account selection. From the shell you will log in
from, confirm none of these are set:

```sh
env | grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_PROFILE|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)' \
  && echo "UNSET THESE FIRST" || echo "clean"
```

Also: **never `--bare`** on subscription profiles (it disables OAuth), and
never mix `CLAUDE_CODE_OAUTH_TOKEN` into an OAuth-file config dir.

## 3. One interactive login per account (T3, owner-run)

The env strings below are the **byte-stable contract**: absolute, no `~`, no
trailing slash, exactly the strings provisioning printed. The CLI hashes the
raw string — a one-byte drift means it silently looks at a different, empty
keychain slot ("logged out").

```sh
AIB="$HOME/.aibender"    # must expand to the SAME absolute AIBENDER_HOME provisioning used

# MAX_A — log in with the account you map to MAX_A
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_PROFILE -u CLAUDE_CODE_OAUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$AIB/accounts/max-a" \
  CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-a" \
  claude
#   → in the TUI, run /login and complete the browser OAuth hop
#   → /exit once authenticated

# MAX_B
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_PROFILE -u CLAUDE_CODE_OAUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$AIB/accounts/max-b" \
  CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-b" \
  claude
#   → /login → browser hop for the MAX_B account → /exit

# ENT
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_PROFILE -u CLAUDE_CODE_OAUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$AIB/accounts/ent" \
  CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/ent" \
  claude
#   → /login → browser hop for the ENT account → /exit
```

Notes:
- Run from a normal **Aqua (GUI) terminal session** — the login keychain must
  be unlocked. Never bootstrap over SSH ([#44089] class failure).
- `claude auth login` is the non-TUI equivalent if preferred; same env block.
- From M2 onward the harness runs this flow for you in an attended PTY
  (BE-2 login bootstrap); the env contract is identical.
- ENT is feature-detected at runtime — managed policy may restrict headless
  use, telemetry, workflows, or models. Expect degraded capability, not error.

## 4. Verify (probe = presence, then prove value access)

**4a. Presence probe (safe, no values read — never `-w`):**

```sh
infra/scripts/accounts/keychain-probe.sh
```

Expect three lines ending `PRESENT`, one per account, each with a distinct
`Claude Code-credentials-<hash8>` service name. Keychain Access will show the
same three items (account attribute = your macOS username).

**4b. Value access in the broker's own context (T3, owner-run):**

```sh
CLAUDE_CONFIG_DIR="$AIB/accounts/max-a" CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-a" claude auth status --json
CLAUDE_CONFIG_DIR="$AIB/accounts/max-b" CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-b" claude auth status --json
CLAUDE_CONFIG_DIR="$AIB/accounts/ent"   CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/ent"   claude auth status --json
```

Each must return parseable JSON showing an authenticated session for the
expected subscription kind (Max / Max / Enterprise). Do not paste the output
anywhere public — it can carry org identity; the harness's own logging redacts
it via `@aibender/shared` filters.

## 5. Lifetime and re-auth

- The login is **once per account per machine** — roughly yearly re-auth in
  practice, or after a credential revocation.
- After CLI **binary updates**, macOS may re-prompt for keychain ACL approval
  ([#19456] class). Click "Always Allow" once per account item; this is not a
  logout.
- Any SDK/CLI **version bump goes through
  [version-gate.md](version-gate.md) first** — non-negotiable (blueprint §3
  rule 4).

## 6. Rung 2 — setup-token procedure (T3, owner-run; canary-gated)

Rung 2 of the [X1] fallback ladder pairs rung 1 with a long-lived
`claude setup-token` injected per process as `CLAUDE_CODE_OAUTH_TOKEN`. Use it
only for: non-Aqua contexts (SSH, headless boot, Background helpers) and
>5-way same-account bursts.

**HARD PRECONDITION:** the setup-token **keychain-deletion canary**
([version-gate.md §5](version-gate.md), issue-#37512 class) must have PASSED
on the currently pinned CLI version. Never enable rung 2 without it.

Per account (shown for MAX_A; repeat with the other dirs/items):

1. Generate, inside that account's own dirs (rule 5: tokens are always paired
   with the same account's config/securestorage dirs):

   ```sh
   CLAUDE_CONFIG_DIR="$AIB/accounts/max-a" \
   CLAUDE_SECURESTORAGE_CONFIG_DIR="$AIB/accounts/max-a" \
   claude setup-token
   ```

2. Store it in the **harness-owned** Keychain item for that label — the item
   name convention is in the profile manifest (`aibender-setup-token-max-a`):

   ```sh
   security add-generic-password -a "$USER" -s "aibender-setup-token-max-a" -w
   ```

   Run exactly like this: `-w` **without a value** prompts interactively, so
   the token never lands in shell history or a transcript. Never echo it.

3. The broker fetches the value at spawn time (its own context, never
   serialized to disk) and injects `CLAUDE_CODE_OAUTH_TOKEN` together with the
   same account's dir env. Harness scripts in this repo never read token
   values.

4. **Yearly rotation:** setup-tokens are long-lived. Record the creation date
   (e.g. in the Keychain item comment); rotation = re-run step 1–2. The
   rotation reminder is surfaced in the UI from M2 (blueprint §3 rule 5) —
   until then, calendar it.

## 7. Watch rung — `ant` profiles: **HOLD**

The `ant` CLI profile mechanism (`ANTHROPIC_PROFILE`) stays at the **watch
rung** of the ladder. The Stage-2 experiment verdict is
**HOLD — watch rung unchanged**: see
[docs/spikes/spike-e-signing-ant.md](../spikes/spike-e-signing-ant.md) for the
evidence table, the owner-run T3 experiment procedure, and the re-evaluation
trigger (promote toward rung 1 only if Max-subscription profile support is
confirmed; profile ≠ subscription quota means HOLD). Do not adopt `ant`
profiles for account selection anywhere in the harness until that verdict
flips.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Account "logged out" though you never logged out | Byte drift in the dir string (different `$AIBENDER_HOME` spelling, trailing slash, `~` unexpanded) | `keychain-probe.sh` — a `DRIFT` line means the marker disagrees with today's recompute. Restore the exact original string; never re-login to "fix" it |
| `provision-accounts.sh` says REFUSED | Dir populated but not provisioned by the harness | Inspect the dir. If it is a pre-existing live login you want to keep, move it aside and re-login via §3, or hand-write the marker after verifying label↔dir (`.aibender-account.json`: `label`, `dir`) |
| Keychain prompt on every launch | ACL reset after a CLI binary update | "Always Allow" once; standardize on one install channel |
| `auth status` fails over SSH / LaunchAgent-Background | Login keychain locked outside Aqua | Expected ([#44089]); that is what rung 2 is for. Broker runs Aqua gui-domain only (SI-3) |
| Probe MISSING for one account | That dir never completed `/login`, or the SDK changed the derivation | Re-run §3 for that account; if it recurs after an SDK bump → [version-gate.md](version-gate.md) BLOCK path |

## T3 pending-owner checklist (real host, real accounts)

- [ ] `provision-accounts.sh` real run against `~/.aibender`
- [ ] Three interactive logins (§3)
- [ ] `keychain-probe.sh` real run → 3× PRESENT
- [ ] `claude auth status --json` × 3 parses authenticated (§4b)
- [ ] `version-gate.sh --init` baseline written after the above
