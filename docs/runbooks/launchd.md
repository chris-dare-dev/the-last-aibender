# Runbook — LaunchAgents: broker (v1-ready) and LM Studio server

**Status:** live for render/lint (M2, SI-3) · **bootstrap steps are T3, owner-run**
**Scripts:** `infra/launchd/render-launchd.sh` (+ `infra/launchd/tests/run.sh`)
**Sources of record:** blueprint §2 (broker must live in the Aqua session),
plan §6/SI-3 + §9.2 SI-3 row,
[session-substrate-tiebreak](../research/findings/session-substrate-tiebreak.md)
(the live launchd/keychain experiment, 2026-07-03).

## Why the Aqua rule exists

gui-domain (Aqua) LaunchAgents have full login-keychain access, including the
ACL-gated value reads Claude Code performs for its
`Claude Code-credentials-<hash8>` items. Background/user-domain agents fail
those reads with `errSecInteractionNotAllowed` (exit 36) — a broker running
there silently "logs out" all provisioned accounts. Verified live on this machine;
the broker plist therefore ships with **no `LimitLoadToSessionType` key**
(LaunchAgent default = Aqua) and is only ever bootstrapped into `gui/$UID`.

Consequence accepted with eyes open: the Aqua domain exists only while the
user is GUI-logged-in. No pre-login/headless broker; if that is ever wanted,
that is exactly [X1] rung 2 (`setup-token`) territory — see
[version-gate.md](version-gate.md) for the canary that gates rung 2.

## Rendering (headless-safe, any time)

```sh
infra/launchd/render-launchd.sh --agent broker    # → $AIBENDER_HOME/launchd/com.aibender.broker.plist
infra/launchd/render-launchd.sh --agent lms       # → $AIBENDER_HOME/launchd/com.aibender.lms.plist
```

Rendering lints the plist (plutil) and is idempotent. It never runs
`launchctl` — the commands below are printed for you, not executed.
Defaults: `--node-bin` from PATH, `--broker-entry
$AIBENDER_HOME/bin/aibender-core.mjs` (packaging lands the real artifact at
M6), `--lms-bin` from PATH.

## T3 — broker bootstrap (the v1 flip; owner-gated, NOT part of M2)

v0 runs the broker as a Tauri sidecar. Flipping to the LaunchAgent is a
deliberate decision (M6+). When flipping:

```sh
launchctl bootstrap gui/$UID "$HOME/.aibender/launchd/com.aibender.broker.plist"
launchctl print gui/$UID/com.aibender.broker | head -20   # state = running
```

Verify keychain access **in the agent's own context** immediately:
`claude auth status --json` per account via the broker, or the SI-2 probe
(`infra/scripts/accounts/keychain-probe.sh`). Unload:

```sh
launchctl bootout gui/$UID/com.aibender.broker
```

## T3 — KeepAlive restart-on-crash observation (plan §9.2 SI-3 edge row)

With the broker agent loaded:

1. `launchctl print gui/$UID/com.aibender.broker` → note the PID.
2. `kill -9 <pid>` (crash, non-zero exit path).
3. Within ~10 s (launchd throttle) a NEW PID appears; the resume ledger
   recovers sessions ([kernel-live-spawn.md](kernel-live-spawn.md)).
4. Clean-exit check: stop the broker gracefully (exit 0) —
   `KeepAlive={SuccessfulExit:false}` must NOT restart it.

Record the observation in the milestone DoD doc.

## T3 — Background-domain expected-failure probe (plan §9.2 SI-3 negative row)

Purpose: re-prove, on the current macOS/CLI pin, that the Background domain
still cannot read keychain values — the failure the Aqua rule protects
against. The probe touches ONLY a harness-owned dummy item [X2].

1. Create the dummy item (owner-run keychain write):
   `security add-generic-password -s aibender-probe-dummy -a "$USER" -w probe-marker-not-a-secret`
2. Render the variant (refused without the acknowledgement flag):
   ```sh
   infra/launchd/render-launchd.sh --agent broker-background-expected-fail \
     --acknowledge-expected-failure
   ```
3. `launchctl bootstrap user/$UID "$HOME/.aibender/launchd/com.aibender.broker.background-expected-fail.plist"`
4. Inspect `$AIBENDER_HOME/logs/background-expected-fail.out.log`:
   - `managername=Background`
   - `dummy-value-exit=36` ← **the expected failure.**
5. Clean up:
   ```sh
   launchctl bootout user/$UID/com.aibender.broker.background-expected-fail
   security delete-generic-password -s aibender-probe-dummy
   rm "$HOME/.aibender/launchd/com.aibender.broker.background-expected-fail.plist"
   ```

**If the value read SUCCEEDS (exit 0) in step 4, stop:** launchd/keychain
semantics have changed; the Aqua ruling and blueprint §2 need re-verification
before trusting any of it. File an ADR.

## T3 — LM Studio agent (optional)

```sh
infra/launchd/render-launchd.sh --agent lms
launchctl bootstrap gui/$UID "$HOME/.aibender/launchd/com.aibender.lms.plist"
```

`lms server start` daemonizes and exits 0; launchd retries only failed
starts. LM Studio remaining down is a NO SIGNAL freshness state (blueprint
§4.3) — the harness must keep working with this agent absent.
