#!/usr/bin/env bats
# live-check.bats — SI-6 tests for the T3 live-check runner + CI helpers.
#
# Plan §9.2 (SI-6 applies the same bar):
#   positive — registry enumerates every milestone check; a bare host runs
#              end-to-end with SKIP(pending-owner) + runbook pointers, exit 0
#   negative — unknown check/milestone rejected; a probe that finds a real
#              problem FAILs the run (stub opencode that never gets healthy);
#              static hygiene: no security(1), no /login, no non-GET curl
#   edge     — offline kill-switch provably prevents spawning; empty
#              check/milestone intersection is a usage error; runner is
#              cwd-independent; single-check selection is exact
#
# Fully headless [X2/T3 boundary]: every test uses a temp HOME/AIBENDER_HOME,
# a stripped PATH, and stub binaries. The real keychain, real account dirs,
# real LM Studio, and a real `opencode serve` are NEVER touched from here.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  LIVECHECK="$REPO_ROOT/infra/ci/live-check.sh"
  PWBROWSERS="$REPO_ROOT/infra/ci/playwright-browsers.sh"
  BRANCHPROT="$REPO_ROOT/infra/ci/apply-branch-protection.sh"

  # Hermetic home: nothing under the real ~/.aibender or ~/.claude is read.
  export FAKE_HOME="$BATS_TEST_TMPDIR/home"
  export EMPTY_AIB="$BATS_TEST_TMPDIR/aibhome"
  mkdir -p "$FAKE_HOME" "$EMPTY_AIB"
  unset AIBENDER_HOME 2>/dev/null || true
  unset AIBENDER_LIVECHECK_OFFLINE 2>/dev/null || true

  # Baseline PATH for hermetic runs: system dirs only (bash, curl, jq, find,
  # uname live there on both macOS and Linux CI), no claude, no opencode.
  SYS_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
}

# Number of rows in the live-check registry — update alongside CHECKS=().
REGISTRY_COUNT=13

run_livecheck_bare() { # extra args forwarded
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$EMPTY_AIB" "$@"
}

# --- positive ----------------------------------------------------------------

@test "--list enumerates the full registry (id, milestone, description, pointer)" {
  run bash "$LIVECHECK" --list
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq "$REGISTRY_COUNT" ]
  # Every row is 4 tab-separated fields with a known milestone tag.
  while IFS=$'\t' read -r id ms desc pointer; do
    [ -n "$id" ] && [ -n "$desc" ] && [ -n "$pointer" ]
    case "$ms" in M1|M2|M3|M4|M6) : ;; *) return 1 ;; esac
  done <<<"$output"
  # The checks the plan names explicitly are all present.
  for id in keychain-probe version-gate auth-status x1-live-demo \
            sigkill-orphan aqua-launchd hooks-installed lmstudio-probe \
            opencode-serve-probe aws-sso-plan x4-hook-slots colima-probe \
            signing-dryrun; do
    grep -q "^$id	" <<<"$output"
  done
}

@test "bare host, offline: full run reports every check, zero FAIL, exit 0" {
  run_livecheck_bare
  [ "$status" -eq 0 ]
  [ "$(grep -c $'^check\t' <<<"$output")" -eq "$REGISTRY_COUNT" ]
  ! grep -q $'\tFAIL\t' <<<"$output"
  grep -q '^RESULT: PASS' <<<"$output"
}

@test "bare host: every SKIP carries a pending-owner pointer" {
  run_livecheck_bare
  [ "$status" -eq 0 ]
  while IFS=$'\t' read -r _ _ _ st detail; do
    if [ "$st" = "SKIP" ]; then
      grep -q 'pending-owner' <<<"$detail"
      # each SKIP names its unblock doc: a runbook, contract, plan §, or findings doc
      grep -Eq 'docs/|plan §' <<<"$detail"
    fi
  done < <(grep $'^check\t' <<<"$output")
}

@test "--milestone M1 selects exactly the five M1 checks, all SKIP on a bare host" {
  run_livecheck_bare --milestone M1
  [ "$status" -eq 0 ]
  [ "$(grep -c $'^check\t' <<<"$output")" -eq 5 ]
  [ "$(grep -c $'\tM1\tSKIP\t' <<<"$output")" -eq 5 ]
}

@test "--check selects exactly one check" {
  run_livecheck_bare --check x1-live-demo
  [ "$status" -eq 0 ]
  [ "$(grep -c $'^check\t' <<<"$output")" -eq 1 ]
  grep -q $'^check\tx1-live-demo\tM1\tSKIP\t' <<<"$output"
}

# --- negative ----------------------------------------------------------------

@test "unknown --check is a usage error (exit 2)" {
  run bash "$LIVECHECK" --check does-not-exist
  [ "$status" -eq 2 ]
  grep -q 'unknown check' <<<"$output"
}

@test "unknown --milestone is a usage error (exit 2)" {
  run bash "$LIVECHECK" --milestone M9
  [ "$status" -eq 2 ]
  grep -q 'unknown milestone' <<<"$output"
}

@test "unknown flag is a usage error (exit 2)" {
  run bash "$LIVECHECK" --frobnicate
  [ "$status" -eq 2 ]
}

@test "opencode probe FAILs the run when serve never becomes healthy" {
  stubdir="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$stubdir"
  cat > "$stubdir/opencode" <<'STUB'
#!/usr/bin/env bash
# broken serve: accepts args, listens on nothing, never healthy
sleep 30
STUB
  chmod +x "$stubdir/opencode"
  HOME="$FAKE_HOME" PATH="$stubdir:$SYS_PATH" AIBENDER_OPENCODE_TIMEOUT=2 \
    run bash "$LIVECHECK" --aibender-home "$EMPTY_AIB" --check opencode-serve-probe
  [ "$status" -eq 1 ]
  grep -q $'^check\topencode-serve-probe\tM2\tFAIL\t' <<<"$output"
  grep -q '^RESULT: FAIL' <<<"$output"
}

@test "static hygiene: live-check never calls security(1), /login, or non-GET curl" {
  code="$(grep -vE '^[[:space:]]*#' "$LIVECHECK")"
  ! grep -Eq '(^|[^a-zA-Z-])security[[:space:]]' <<<"$code"
  ! grep -Fq '/login' <<<"$code"
  ! grep -Eq 'curl[^|]*-X' <<<"$code"          # read-only GETs only
  ! grep -Eq 'launchctl (boot|load|unload|enable|kickstart)' <<<"$code"
  ! grep -Eq 'terraform[[:space:]]+apply' <<<"$code"
}

@test "auth-status stays SKIP without --allow-real-accounts even when provisioned" {
  aib="$BATS_TEST_TMPDIR/provisioned"
  mkdir -p "$aib/accounts/max-a"
  printf '{"label":"max-a","dir":"%s"}\n' "$aib/accounts/max-a" \
    > "$aib/accounts/max-a/.aibender-account.json"
  stubdir="$BATS_TEST_TMPDIR/bin-claude"
  mkdir -p "$stubdir"
  cat > "$stubdir/claude" <<'STUB'
#!/usr/bin/env bash
echo '{"stub":true}'
STUB
  chmod +x "$stubdir/claude"
  HOME="$FAKE_HOME" PATH="$stubdir:$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check auth-status
  [ "$status" -eq 0 ]
  grep -q $'^check\tauth-status\tM1\tSKIP\t' <<<"$output"
}

@test "hooks-installed: PASS when every provisioned account carries aibender /hooks/v1/ entries" {
  aib="$BATS_TEST_TMPDIR/hooked"
  for label in max-a max-b; do
    mkdir -p "$aib/accounts/$label"
    printf '{"label":"%s"}\n' "$label" \
      > "$aib/accounts/$label/.aibender-account.json"
    cat > "$aib/accounts/$label/settings.json" <<'JSON'
{
  "env": { "USER_KEY": "preserved" },
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "http", "url": "http://127.0.0.1:4319/hooks/v1/MAX_A", "timeout": 5 }] }
    ]
  }
}
JSON
    printf '{"schemaVersion":1,"label":"%s"}\n' "$label" \
      > "$aib/accounts/$label/.aibender-hooks.json"
  done
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check hooks-installed
  [ "$status" -eq 0 ]
  grep -q $'^check\thooks-installed\tM2\tPASS\t' <<<"$output"
  grep -q 'per-account settings.json' <<<"$output"
}

@test "hooks-installed: personal ~/.claude mentioning 'aibender' must NOT produce a PASS" {
  # Regression: the check must read the per-account config dirs, never
  # $HOME/.claude — a personal settings.json that merely contains the string
  # 'aibender' used to spuriously PASS the M2 gate.
  mkdir -p "$FAKE_HOME/.claude"
  printf '{"note":"aibender mentioned here, no hooks"}\n' \
    > "$FAKE_HOME/.claude/settings.json"
  aib="$BATS_TEST_TMPDIR/nohooks"
  mkdir -p "$aib/accounts/ent"
  printf '{"label":"ent"}\n' > "$aib/accounts/ent/.aibender-account.json"
  printf '{"permissions":{"allow":["Bash(aibender:*)"]}}\n' \
    > "$aib/accounts/ent/settings.json"
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check hooks-installed
  [ "$status" -eq 0 ]
  grep -q $'^check\thooks-installed\tM2\tSKIP\t' <<<"$output"
  grep -q 'pending-owner' <<<"$output"
  grep -q 'hooks-telemetry.md' <<<"$output"
}

# --- edge --------------------------------------------------------------------

@test "hooks-installed: partial install SKIPs and names the missing account" {
  aib="$BATS_TEST_TMPDIR/partial"
  for label in max-a ent; do
    mkdir -p "$aib/accounts/$label"
    printf '{"label":"%s"}\n' "$label" \
      > "$aib/accounts/$label/.aibender-account.json"
  done
  cat > "$aib/accounts/max-a/settings.json" <<'JSON'
{"hooks":{"Stop":[{"hooks":[{"type":"http","url":"http://127.0.0.1:4319/hooks/v1/MAX_A","timeout":5}]}]}}
JSON
  # ent is provisioned but has no settings.json at all
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check hooks-installed
  [ "$status" -eq 0 ]
  grep -q $'^check\thooks-installed\tM2\tSKIP\t' <<<"$output"
  grep -q 'ent' <<<"$output"
  grep -q 'hooks-telemetry.md' <<<"$output"
}

@test "offline kill-switch provably prevents spawning opencode" {
  stubdir="$BATS_TEST_TMPDIR/bin-sentinel"
  mkdir -p "$stubdir"
  sentinel="$BATS_TEST_TMPDIR/spawned"
  cat > "$stubdir/opencode" <<STUB
#!/usr/bin/env bash
touch "$sentinel"
sleep 30
STUB
  chmod +x "$stubdir/opencode"
  HOME="$FAKE_HOME" PATH="$stubdir:$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$EMPTY_AIB" --check opencode-serve-probe
  [ "$status" -eq 0 ]
  grep -q $'^check\topencode-serve-probe\tM2\tSKIP\t' <<<"$output"
  [ ! -e "$sentinel" ]
}

@test "empty --milestone/--check intersection is an error, not a silent PASS" {
  run bash "$LIVECHECK" --milestone M3 --check keychain-probe
  [ "$status" -eq 2 ]
  grep -q 'no checks selected' <<<"$output"
}

@test "runner is cwd-independent" {
  cd /
  run_livecheck_bare --check sigkill-orphan
  [ "$status" -eq 0 ]
  grep -q $'^check\tsigkill-orphan\tM1\tSKIP\t' <<<"$output"
}

@test "version-gate SKIPs with a §0 pointer when no certified baseline exists" {
  # Provisioned account but no state/version-gate.json → the runbook's
  # --init step is the unblock; only meaningful where the probe leg could
  # run (macOS); elsewhere the macOS-only SKIP wins — both are SKIP.
  aib="$BATS_TEST_TMPDIR/prov2"
  mkdir -p "$aib/accounts/ent"
  printf '{"label":"ent","dir":"%s"}\n' "$aib/accounts/ent" \
    > "$aib/accounts/ent/.aibender-account.json"
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check version-gate
  [ "$status" -eq 0 ]
  grep -q $'^check\tversion-gate\tM1\tSKIP\t' <<<"$output"
  grep -q 'version-gate.md' <<<"$output"
}

# --- M4 checks: SI-3 [X4] slots + SI-5 colima probe (surgical append) ----------

# Per-account fixture with the M4-active [X4] slots ($1 = label, $2 = SessionStart timeout).
x4_settings_fixture() {
  cat <<JSON
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "http", "url": "http://127.0.0.1:4319/hooks/v1/$1", "timeout": $2 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "http", "url": "http://127.0.0.1:4319/hooks/v1/$1", "timeout": 5 }] }
    ],
    "PreCompact": [
      { "hooks": [{ "type": "http", "url": "http://127.0.0.1:4319/hooks/v1/$1", "timeout": 5 }] }
    ]
  }
}
JSON
}

@test "x4-hook-slots: PASS when every provisioned account carries the M4-active slots" {
  aib="$BATS_TEST_TMPDIR/x4active"
  for label in max-a ent; do
    mkdir -p "$aib/accounts/$label"
    printf '{"label":"%s"}\n' "$label" > "$aib/accounts/$label/.aibender-account.json"
    x4_settings_fixture "MAX_A" 10 > "$aib/accounts/$label/settings.json"
  done
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check x4-hook-slots
  [ "$status" -eq 0 ]
  grep -q $'^check\tx4-hook-slots\tM4\tPASS\t' <<<"$output"
  # honest posture rides the detail: injection stays 204-default until T3
  grep -q '204-default' <<<"$output"
  grep -q '§7.1' <<<"$output"
}

@test "x4-hook-slots: M2/M3-era install (SessionStart 5 s) SKIPs pending-owner naming the stale account" {
  aib="$BATS_TEST_TMPDIR/x4stale"
  mkdir -p "$aib/accounts/max-b"
  printf '{"label":"max-b"}\n' > "$aib/accounts/max-b/.aibender-account.json"
  x4_settings_fixture "MAX_B" 5 > "$aib/accounts/max-b/settings.json"
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check x4-hook-slots
  [ "$status" -eq 0 ]
  grep -q $'^check\tx4-hook-slots\tM4\tSKIP\t' <<<"$output"
  grep -q 'pending-owner' <<<"$output"
  grep -q 'max-b' <<<"$output"
  grep -q 'hooks-telemetry.md' <<<"$output"
}

@test "x4-hook-slots: hooks installed but the SessionStart matcher missing is NOT M4-active" {
  aib="$BATS_TEST_TMPDIR/x4nomatcher"
  mkdir -p "$aib/accounts/ent"
  printf '{"label":"ent"}\n' > "$aib/accounts/ent/.aibender-account.json"
  x4_settings_fixture "ENT" 10 \
    | jq 'del(.hooks.SessionStart[0].matcher)' \
    > "$aib/accounts/ent/settings.json"
  HOME="$FAKE_HOME" PATH="$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$aib" --check x4-hook-slots
  [ "$status" -eq 0 ]
  grep -q $'^check\tx4-hook-slots\tM4\tSKIP\t' <<<"$output"
  grep -q 'pending-owner' <<<"$output"
}

@test "x4-hook-slots: bare host SKIPs pending-owner" {
  run_livecheck_bare --check x4-hook-slots
  [ "$status" -eq 0 ]
  grep -q $'^check\tx4-hook-slots\tM4\tSKIP\t' <<<"$output"
  grep -q 'pending-owner' <<<"$output"
}

# Minimal colima/limactl stubs for the probe's version + status legs only —
# the mapping tests below never reach a network leg by construction.
write_colima_stubs() { # $1 = dir, $2 = colima version, $3 = status exit
  mkdir -p "$1"
  cat > "$1/colima" <<STUB
#!/usr/bin/env bash
case "\$1" in
  version) printf 'colima version %s\n' "$2" ;;
  status) exit $3 ;;
  *) echo "stub colima: unexpected: \$*" >&2; exit 64 ;;
esac
STUB
  cat > "$1/limactl" <<'STUB'
#!/usr/bin/env bash
printf 'limactl version 2.1.1\n'
STUB
  chmod +x "$1/colima" "$1/limactl"
}

@test "colima-probe: offline kill-switch SKIPs and provably never invokes the toolchain" {
  stubdir="$BATS_TEST_TMPDIR/bin-colima-sentinel"
  mkdir -p "$stubdir"
  sentinel="$BATS_TEST_TMPDIR/colima-invoked"
  cat > "$stubdir/colima" <<STUB
#!/usr/bin/env bash
touch "$sentinel"
STUB
  chmod +x "$stubdir/colima"
  cp "$stubdir/colima" "$stubdir/limactl"
  HOME="$FAKE_HOME" PATH="$stubdir:$SYS_PATH" AIBENDER_LIVECHECK_OFFLINE=1 \
    run bash "$LIVECHECK" --aibender-home "$EMPTY_AIB" --check colima-probe
  [ "$status" -eq 0 ]
  grep -q $'^check\tcolima-probe\tM4\tSKIP\t' <<<"$output"
  grep -q 'pending-owner' <<<"$output"
  grep -q 'colima.md' <<<"$output"
  [ ! -e "$sentinel" ]
}

@test "colima-probe: probe DOWN (exit 3 — VM stopped) maps to SKIP pending-owner, run exit 0" {
  # Pinned versions + VM not running: the probe exits 3 before any network
  # leg; the check must report DOWN-as-state, never FAIL.
  stubdir="$BATS_TEST_TMPDIR/bin-colima-down"
  write_colima_stubs "$stubdir" "0.10.1" 1
  HOME="$FAKE_HOME" PATH="$stubdir:$SYS_PATH" \
    run bash "$LIVECHECK" --aibender-home "$EMPTY_AIB" --check colima-probe
  [ "$status" -eq 0 ]
  grep -q $'^check\tcolima-probe\tM4\tSKIP\t' <<<"$output"
  grep -q 'pending-owner' <<<"$output"
  grep -q 'owner-gated' <<<"$output"
  grep -q '^RESULT: PASS' <<<"$output"
}

@test "colima-probe: probe RED (exit 1 — unapproved drift) maps to FAIL and fails the run" {
  # Drifted colima version + VM down: pins leg FAILs, RED wins over DOWN
  # (probe exit 1) with zero network activity — the check must FAIL.
  stubdir="$BATS_TEST_TMPDIR/bin-colima-red"
  write_colima_stubs "$stubdir" "0.9.0" 1
  HOME="$FAKE_HOME" PATH="$stubdir:$SYS_PATH" \
    run bash "$LIVECHECK" --aibender-home "$EMPTY_AIB" --check colima-probe
  [ "$status" -eq 1 ]
  grep -q $'^check\tcolima-probe\tM4\tFAIL\t' <<<"$output"
  grep -q 'colima.md' <<<"$output"
  grep -q '^RESULT: FAIL' <<<"$output"
}

@test "--milestone M4 selects exactly the two M4 checks" {
  run_livecheck_bare --milestone M4
  [ "$status" -eq 0 ]
  [ "$(grep -c $'^check\t' <<<"$output")" -eq 2 ]
  grep -q $'^check\tx4-hook-slots\tM4\t' <<<"$output"
  grep -q $'^check\tcolima-probe\tM4\t' <<<"$output"
}

# --- playwright-browsers.sh --------------------------------------------------

@test "playwright-browsers: clean no-op when no workspace package has playwright" {
  root="$BATS_TEST_TMPDIR/noplaywright"
  mkdir -p "$root/app" "$root/core"
  run bash "$PWBROWSERS" --root "$root"
  [ "$status" -eq 0 ]
  grep -q 'no-op' <<<"$output"
}

@test "playwright-browsers: unknown flag is a usage error (exit 2)" {
  run bash "$PWBROWSERS" --bogus
  [ "$status" -eq 2 ]
}

# --- apply-branch-protection.sh (config as code — NEVER executed by CI) -----

@test "branch-protection: dry-run prints config + command, applies nothing, needs no gh" {
  # PATH without gh proves the dry-run path cannot mutate GitHub.
  PATH="$SYS_PATH" run bash "$BRANCHPROT" --repo chris-dare-dev/the-last-aibender
  [ "$status" -eq 0 ]
  grep -q 'DRY-RUN' <<<"$output"
  grep -q 'required_status_checks' <<<"$output"
  grep -q -- '--yes' <<<"$output"
}

@test "branch-protection: refuses to run without --repo (never inferred)" {
  run bash "$BRANCHPROT"
  [ "$status" -eq 2 ]
  grep -q -- '--repo' <<<"$output"
}

@test "branch-protection: --yes path PUTs the JSON via gh (stubbed)" {
  stubdir="$BATS_TEST_TMPDIR/bin-gh"
  mkdir -p "$stubdir"
  log="$BATS_TEST_TMPDIR/gh.log"
  cat > "$stubdir/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log"
cat >> "$log"   # capture --input - payload
exit 0
STUB
  chmod +x "$stubdir/gh"
  PATH="$stubdir:$SYS_PATH" run bash "$BRANCHPROT" --repo owner/name --branch main --yes
  [ "$status" -eq 0 ]
  grep -q 'repos/owner/name/branches/main/protection' "$log"
  grep -q -- '--method PUT' "$log"
  # payload reached gh and the $comment doc key was stripped
  grep -q 'linux-tests' "$log"
  ! grep -q '\$comment' "$log"
}

@test "branch-protection: contexts in JSON match the ci.yml job names + gitleaks" {
  json="$REPO_ROOT/infra/ci/branch-protection.json"
  for ctx in $(jq -r '.required_status_checks.contexts[]' "$json"); do
    if [ "$ctx" = "gitleaks" ]; then
      grep -q '^  gitleaks:' "$REPO_ROOT/.github/workflows/gitleaks.yml"
    else
      grep -q "^  $ctx:" "$REPO_ROOT/.github/workflows/ci.yml"
    fi
  done
}

@test "playwright-browsers: installs chromium, adds webkit only with --with-webkit" {
  root="$BATS_TEST_TMPDIR/withpw"
  bin="$root/app/node_modules/.bin"
  mkdir -p "$bin"
  log="$BATS_TEST_TMPDIR/pw.log"
  cat > "$bin/playwright" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log"
STUB
  chmod +x "$bin/playwright"

  run bash "$PWBROWSERS" --root "$root"
  [ "$status" -eq 0 ]
  grep -q 'chromium' "$log"
  ! grep -q 'webkit' "$log"

  : > "$log"
  run bash "$PWBROWSERS" --root "$root" --with-webkit
  [ "$status" -eq 0 ]
  grep -q 'chromium' "$log"
  grep -q 'webkit' "$log"
}
