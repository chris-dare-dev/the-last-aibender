# Runbook — hooks & telemetry wiring: per-account settings install

**Status:** live for headless install into provisioned dirs (M2, SI-3) ·
**install into the REAL account dirs is T3, owner-run**
**Scripts:** `infra/hooks/install-hook-settings.sh` /
`uninstall-hook-settings.sh` (+ `infra/hooks/tests/run.sh`)
**Sources of record:** blueprint §4.1 (semantics never from PTY bytes; hooks
are feed (b)), §6.1 (collection matrix),
[hooks-contract.md](../contracts/hooks-contract.md) (FROZEN-M2 — the POST
surface), plan §6/SI-3 + §9.2 SI-3 row, §9.3 BE↔SI #3/#4.

## What one install gives each account

Merged into `<CLAUDE_CONFIG_DIR>/settings.json` (user settings preserved —
merge, never overwrite; proven by the fixture-tree suite):

| Piece | Effect |
|---|---|
| `hooks` | 29 contract events, each a `type:"http"` POST (5 s timeout) to `http://127.0.0.1:4319/hooks/v1/<LABEL>`. Covers harness-launched **and** external sessions — this is how the context graph and reconciler see sessions the harness didn't spawn. The [X4] slots (`SessionStart`/`SessionEnd`/`PreCompact`) ride the same envelope; BE-7 consumes them from the store (M4). |
| `statusLine` | The quota tee: every render tick's stdin JSON lands verbatim (atomic, 0600) in `$AIBENDER_HOME/quota/<LABEL>.json` → BE-5 → `quota_snapshots` → the quota channel (ws-protocol §11). A pre-existing statusline keeps producing the visible line via a captured passthrough snippet. |
| `env` | The OTel block: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP → `http://127.0.0.1:4318`, `OTEL_LOG_TOOL_DETAILS=1` (else custom skills show as `custom`), `OTEL_RESOURCE_ATTRIBUTES=account=<LABEL>`, `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`. Attribution by construction, labels only [X2]. |

Until BE-5 lands (M3) the POSTs hit connection-refused and the 5 s-timeout
fire-and-forget posture means sessions are unaffected — installing at M2 is
safe and deliberate.

## Headless rehearsal (safe anywhere, what CI runs)

```sh
AIBENDER_HOME=/tmp/aib-rehearsal infra/scripts/accounts/provision-accounts.sh
AIBENDER_HOME=/tmp/aib-rehearsal infra/hooks/install-hook-settings.sh
AIBENDER_HOME=/tmp/aib-rehearsal infra/hooks/uninstall-hook-settings.sh
rm -rf /tmp/aib-rehearsal
```

## T3 — live install into the real account dirs (owner-run)

Prereqs: accounts provisioned + logged in
([login-bootstrap.md](login-bootstrap.md)).

1. Dry-run first, review the plan:
   `infra/hooks/install-hook-settings.sh --dry-run`
2. Install: `infra/hooks/install-hook-settings.sh`
   (idempotent; re-run any time; `--label MAX_A` to scope).
3. Start a real session in one account and verify:
   - `$AIBENDER_HOME/quota/<LABEL>.json` appears and refreshes on
     statusline ticks (contains `rate_limits.five_hour/seven_day`);
   - the CLI accepts every hook registration on the **pinned** version — no
     startup warnings about unknown hook events or the `http` hook type
     (the contract vocabulary tracks the 2026 hook set; a pinned-CLI
     mismatch is an ICR, not a template hack);
   - the visible statusline still renders (passthrough if you had one).
4. After BE-5 (M3): confirm POSTs land — §9.3 BE↔SI #3 (statusline +
   http-hook events → `quota_snapshots`/`events`) and #4 (OTLP rows carry
   `account=<LABEL>`).

**Policy-floor caveat (hooks-contract §4, T3):** the CLI-side interpretation
of http-hook `permissionDecision` response bodies MUST be verified against
the pinned CLI before the collector's floor ever switches from observe-only
to enforcing. The request shape is frozen either way.

## Uninstall / rollback

`infra/hooks/uninstall-hook-settings.sh` removes exactly what was installed
(state file `.aibender-hooks.json` per account), restores a captured user
statusline, leaves user-edited values with a warning, and with
`--purge-shared` also removes `$AIBENDER_HOME/bin/aibender-statusline.sh` +
the quota files. Custom ports used at install time must be repeated if the
state file is gone.

## [X2] notes

- Committed templates carry placeholder labels only; the collector
  attributes events to the URL's label segment and nothing else
  (hooks-contract §1) — never from transcript paths or env.
- The teed statusline payload and quota files stay under `$AIBENDER_HOME`
  (0600/0700), machine-local forever.
- The hook set registers **no shell-outs** — http POSTs to 127.0.0.1 only
  (tested against template and installed trees).
