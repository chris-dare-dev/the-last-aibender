# infra/hooks/ — per-account hook settings templates (SI-3)

The per-account `settings.json` fragments that make every Claude Code
session — harness-launched **and** external — feed the harness: http event
hooks, the statusline quota tee, and the OTel env block. Blueprint §4.1/§6.1;
plan §6/SI-3; the POST surface is the **FROZEN-M2**
[hooks-contract.md](../../docs/contracts/hooks-contract.md).

| File | Purpose |
|---|---|
| `templates/settings.fragment.json.template` | The merged fragment: `env` (OTel block), `statusLine` (quota tee), `hooks` (the 29-event contract vocabulary, each a `type:"http"` POST). Double-brace tokens are rendered per account. |
| `statusline/aibender-statusline.sh` | Statusline tee: writes each render tick's stdin JSON **verbatim, atomically, 0600** to `$AIBENDER_HOME/quota/<LABEL>.json` (BE-5's quota feed, ws-protocol §11), then emits the visible line — the user's captured pre-install statusline via passthrough, else a minimal `<LABEL> 5h:NN% 7d:NN%`. Never breaks a tick (always exits 0). Installed to `$AIBENDER_HOME/bin/`. |
| `install-hook-settings.sh` | Idempotent installer: **merge, never overwrite** — user permissions/env/hooks/unknown keys all survive; aibender-owned hook entries (all-http, loopback `/hooks/v1/` URLs) are replaced in place; invalid JSON is refused untouched. Writes a per-account state file (`.aibender-hooks.json`) for surgical uninstall. |
| `uninstall-hook-settings.sh` | Removes exactly what the installer added; restores a captured user statusline; leaves user-edited values in place with a warning; deletes `settings.json` only when nothing but aibender keys ever lived in it. |
| `lib.sh` | Shared helpers (builds on `infra/scripts/accounts/lib.sh`): URL/env builders, fragment renderer, the aibender-entry jq predicate, provenance-marker guard. |
| `tests/` | Headless bats + shellcheck against temp `$AIBENDER_HOME` + fixture settings trees. `bash infra/hooks/tests/run.sh` |

## Contract obligations honored here (hooks-contract.md §5)

1. One template, three installs — **the only per-account difference is the
   `<ACCOUNT_LABEL>` path segment** of
   `http://127.0.0.1:<hooksPort>/hooks/v1/<LABEL>` (tested).
2. Short hook `timeout` (5 s; SessionStart 10 s — see 4) — a dead collector
   can never stall a session.
3. **No shell-outs**: every registered hook is a loopback http POST [X2]
   (tested against both the template and installed trees).
4. The [X4] automation set (`SessionStart` matcher
   `startup|resume|clear|compact`, `SessionEnd`, `PreCompact`) rides the
   **same** envelope — no second transport. **ACTIVE since M4**
   (hooks-contract.md §7.1 routing amendment): `SessionEnd`/`PreCompact`
   are post-ack fire-and-forget collector-side and keep the 5 s window;
   `SessionStart` is the ONE slot whose `200` response the CLI applies as
   hook output — the frozen brief-injection shape
   (`hookSpecificOutput.additionalContext`) — so its template entry carries
   a widened 10 s response window for the collector's deadline race. The
   per-account state file records the activation (`x4` block, derived from
   the installed settings). Injection stays **204-default** until the T3
   pinned-CLI verification lands (see below).

## Ports (configuration, not contract)

- hooks collector: `4319` (`AIBENDER_HOOKS_PORT` / `--hooks-port`) — BE-5, M3.
- OTLP receiver: `4318` (`AIBENDER_OTLP_PORT` / `--otlp-port`) — BE-5, M3.

The OTel env block sets `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
`OTEL_LOG_TOOL_DETAILS=1` (else custom skills report as `custom`),
`OTEL_RESOURCE_ATTRIBUTES=account=<LABEL>` (placeholder labels only [X2]) and
`OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` (account-UUID attribution off).

**T3 (owner-run):** installing into the REAL account dirs and verifying the
pinned CLI accepts every registration (incl. the http-hook
`permissionDecision` response semantics before the policy floor ever turns
enforcing — hooks-contract §4 — and, since M4, the CLI-side interpretation
of the SessionStart `200` `additionalContext` body before brief injection
turns on — hooks-contract §7.1) — procedure in
[docs/runbooks/hooks-telemetry.md](../../docs/runbooks/hooks-telemetry.md).
