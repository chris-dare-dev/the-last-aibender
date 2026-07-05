# infra/ci/ — CI expansion & live-check runner (SI-6)

Owner package: **SI-6** (plan §6/SI-6, lane SI-A). This directory holds
everything CI-shaped that is not a workflow file: the T3 live-check runner,
CI helper scripts, branch-protection config as code, and their tests.

## The three test surfaces (plan §9.1)

| Tier | Where it runs | Entry |
|---|---|---|
| T1/T2 unit + component | hosted CI, Linux (`linux-tests`) + macOS build job | `.github/workflows/ci.yml` |
| shell/infra | hosted CI (`infra-tests`) | the `pnpm run test:infra` composite (`infra/scripts/tests/run.sh` + `infra/launchd/tests/run.sh` + `infra/hooks/tests/run.sh`) + `infra/ci/tests/run.sh` |
| **T3 live-host** | **never hosted** — owner-run on the real Mac at milestone gates | `infra/ci/live-check.sh` |

## Workflow map (`.github/workflows/`)

| Workflow | Jobs | Notes |
|---|---|---|
| `ci.yml` | `linux-tests`, `design-tokens`, `infra-tests`, `macos-build` | the full pipeline; job names are the branch-protection contexts |
| `gitleaks.yml` | `gitleaks` | [X2] backstop — deliberately a separate workflow/failure domain |
| `trufflehog-weekly.yml` | `trufflehog` | weekly verified-secrets deep scan (Mondays 06:00 UTC) |

`macos-build` is **build-only by design**: core tsc, app typecheck + token
build, app vite build when FE-2 lands it (`--if-present`), `cargo check` of
`src-tauri` when it lands (detected, conditional) — **never a full tauri
bundle in CI** — plus darwin-tagged units and the `aibender-app-build`
artifact upload. Everything that needs the real machine is live-check's job.

## Platform/test tag conventions (normative)

The pipeline stays green on trees where tagged specs do not exist yet; the
conventions cost nothing until a package opts in.

- **macOS-only specs** — file name contains `.darwin.` (e.g.
  `ptyHost.darwin.spec.ts`) **and** the suite self-guards:

  ```ts
  describe.skipIf(process.platform !== 'darwin')('aqua-only …', () => { … });
  ```

  Linux CI runs them as skipped (the guard); the macOS job executes exactly
  these via the vitest filename filter:
  `pnpm -r --if-present run test darwin --passWithNoTests`.

- **WebKit-only specs** (Playwright islands) — self-guard on the env CI sets:

  ```ts
  skipIf(process.env.AIBENDER_CI_SKIP_WEBKIT === '1')
  ```

  `ci.yml` sets `AIBENDER_CI_SKIP_WEBKIT=1` on Linux jobs only; the macOS job
  installs WebKit (`playwright-browsers.sh --with-webkit`) and leaves it
  unset.

- **Playwright browsers** — cached per-OS keyed on `pnpm-lock.yaml`;
  `playwright-browsers.sh` resolves the CLI from whichever workspace package
  carries playwright and is a clean no-op when none does.

## `live-check.sh` — the T3 live-host suite

Hosted CI can never see the login keychain, Aqua launchd, the real `claude`
binary, LM Studio, or a real `opencode serve`. `live-check.sh` enumerates
every live-host check **by milestone** and reports
`PASS` / `FAIL` / `SKIP(pending-owner)` — every SKIP names the exact runbook
that unblocks it. It is runnable today on any machine; nothing not-yet-enabled
fails.

```sh
infra/ci/live-check.sh --list                 # the registry
infra/ci/live-check.sh                        # run everything
infra/ci/live-check.sh --milestone M2         # one milestone gate
infra/ci/live-check.sh --check lmstudio-probe # one check
infra/ci/live-check.sh --allow-real-accounts  # + claude auth value-access (owner)
```

Registry (ids are stable; `--list` is authoritative):

| id | M | what |
|---|---|---|
| `keychain-probe` | M1 | per-account keychain item presence (SI-2 probe; never `-w`) |
| `version-gate` | M1 | service-name recompute vs certified baseline |
| `auth-status` | M1 | `claude auth status --json` per account (opt-in `--allow-real-accounts`) |
| `x1-live-demo` | M1 | manual: one broker, three concurrent live sessions (costs usage) |
| `sigkill-orphan` | M1 | manual: real-child SIGKILL orphan/resume re-run |
| `aqua-launchd` | M2 | SI-3 rendered plists lint + Aqua gui-domain state |
| `hooks-installed` | M2 | SI-3 hook settings installed into the per-account config dirs (`$AIBENDER_HOME/accounts/<label>/settings.json` — read-only; never `~/.claude`) |
| `lmstudio-probe` | M2 | LM Studio reachability on 127.0.0.1 (never auto-started; down ⇒ SKIP) |
| `opencode-serve-probe` | M2 | temp `opencode serve`: `/global/health`, `/session`, `/event` **only** |
| `aws-sso-plan` | M3 | owner-run terraform plan (apply is hard-gated) |
| `x4-hook-slots` | M4 | SI-3 [X4] automation slots M4-active in the per-account settings (SessionStart matcher + 10 s response window, SessionEnd/PreCompact registered — read-only; injection stays 204-default until the hooks-contract §7.1 T3 proof) |
| `colima-probe` | M4 | SI-5 pod→host loopback gate run read-only; GREEN/DOWN/RED → PASS/SKIP(pending-owner)/FAIL (VM/LM Studio never started; docs/runbooks/colima.md) |
| `signing-dryrun` | M6 | signed (dry-run) sidecar artifact cold-start (spike ix follow-on) |

Hard rules baked in (and enforced by the bats static-hygiene test): no
`security(1)` calls, no `/login`, read-only GETs only (no `curl -X`), no
`launchctl` mutations, no `terraform apply`, LM Studio never started,
`opencode serve` limited to health/list/event and killed on exit.

`AIBENDER_LIVECHECK_OFFLINE=1` forces the network/spawn checks to SKIP — the
bats suite uses it; it is also handy offline.

## Branch protection as code (pending-owner)

Desired protection for `main` lives in `branch-protection.json` (required
green: the four `ci.yml` jobs + `gitleaks`; `strict` up-to-date; no force
pushes/deletions; linear history; admins enforced; **no PR-review
requirement** — single-owner repo, the serial gate pushes directly).

`apply-branch-protection.sh` shows the config and applies it **only** with
both `--repo` and `--yes`. It is never executed by CI or agents — applying is
an owner-run GitHub mutation, to be done **after the repo is first pushed**:

```sh
infra/ci/apply-branch-protection.sh --repo chris-dare-dev/the-last-aibender          # dry-run
infra/ci/apply-branch-protection.sh --repo chris-dare-dev/the-last-aibender --yes    # owner-run
```

A bats test pins the JSON contexts to the actual workflow job names so the
two can never drift silently.

## Tests

`infra/ci/tests/run.sh` — shellcheck over every script here + the bats suite
(`live-check.bats`: positive/negative/edge per plan §9.2, fully headless —
temp homes, stripped PATHs, stub `opencode`/`claude`/`gh`; the real keychain,
accounts, LM Studio, and network are never touched). CI runs it in the
`infra-tests` job right after the `pnpm run test:infra` composite suites
(`infra/scripts`, `infra/launchd`, `infra/hooks`).
