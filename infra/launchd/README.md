# infra/launchd/ — Aqua LaunchAgent plist templates (SI-3)

LaunchAgent templates for the broker (v1-READY, **not flipped** — v0 runs the
broker as a Tauri sidecar) and the LM Studio server, plus the documented
**expected-failure** Background-domain variant. Blueprint §2; plan §6/SI-3;
live-verified launchd/keychain semantics in
[session-substrate-tiebreak](../../docs/research/findings/session-substrate-tiebreak.md).

**The one rule that matters:** the broker must live in the **Aqua (gui)
domain**. gui-domain LaunchAgents have full login-keychain value access;
Background/user-domain agents fail Claude Code's credential reads with
`errSecInteractionNotAllowed` (exit-36 class) and silently "log out" all
three accounts. The broker template therefore carries **no**
`LimitLoadToSessionType` key — the LaunchAgent default is Aqua — and the
tests assert the key's absence.

| File | Purpose |
|---|---|
| `templates/com.aibender.broker.plist.template` | Broker agent — default (Aqua) session type, `RunAtLoad`, `KeepAlive={SuccessfulExit:false}`. Rendered and lint-validated at M2; **FINALIZED v1-ready at M6** (shape frozen + lint-asserted; broker-entry points at the M6-packaged broker); **bootstrapping it is the deliberate v1 flip, owner-gated** ([runbook](../../docs/runbooks/launchd.md)). |
| `templates/com.aibender.lms.plist.template` | `lms server start` at login; retry only on failed start. LM Studio down stays a first-class NO SIGNAL state, never an error. |
| `templates/com.aibender.broker.background-expected-fail.plist.template` | The forbidden variant, kept as the T3 **expected-failure probe** (plan §9.2 SI-3 negative row). Probes a harness-owned dummy keychain item only [X2]. Render is refused without `--acknowledge-expected-failure`. |
| `render-launchd.sh` | Substitutes machine-local values, lints (plutil / plistlib), writes to `$AIBENDER_HOME/launchd/`, prints the **owner-run** `launchctl` commands. **Never executes `launchctl` or `security` itself** (proven by a runtime-stub test). |
| `tests/` | Headless bats + shellcheck: lint, Aqua-default assertion, expected-failure refusal discipline, idempotent re-render, XML-hostile paths, forbidden-tool stub proof. `bash infra/launchd/tests/run.sh` |

Machine-local render target: `$AIBENDER_HOME/launchd/*.plist` — never
`~/Library/LaunchAgents` directly; the owner copies/bootstraps per the
runbook. Templates contain machine-local path tokens only — no identities,
no tokens [X2].

**T3 (owner-run, milestone gates):** actual `launchctl bootstrap gui/$UID`,
KeepAlive crash-restart observation, and the Background expected-failure
probe — procedures in [docs/runbooks/launchd.md](../../docs/runbooks/launchd.md).
