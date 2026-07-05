#!/usr/bin/env bats
# launchd.bats — SI-3 LaunchAgent template + render tests.
#
# Plan §9.2 SI-3 row:
#   positive — plists lint; Aqua session type asserted (broker carries NO
#              LimitLoadToSessionType key → launchd default = Aqua)
#   negative — Background/user-domain variant is the documented
#              EXPECTED-FAILURE probe: render REFUSED without the explicit
#              acknowledgement flag; the live keychain failure observation
#              itself is T3, owner-run (docs/runbooks/launchd.md)
#   edge     — KeepAlive restart-on-crash is T3 (owner-observed); headless
#              edges here: re-render idempotency, XML-escaping of hostile
#              paths, dry-run writes nothing, launchctl/security NEVER
#              executed by the render script
#
# Fully headless: temp $AIBENDER_HOME, stubbed launchctl/security on PATH.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  RENDER="$REPO_ROOT/infra/launchd/render-launchd.sh"
  export AIBENDER_HOME="$BATS_TEST_TMPDIR/aibhome"
  NODE_BIN_FIXTURE="$BATS_TEST_TMPDIR/fake-node"
  LMS_BIN_FIXTURE="$BATS_TEST_TMPDIR/fake-lms"
  printf '#!/bin/sh\nexit 0\n' > "$NODE_BIN_FIXTURE"; chmod +x "$NODE_BIN_FIXTURE"
  printf '#!/bin/sh\nexit 0\n' > "$LMS_BIN_FIXTURE"; chmod +x "$LMS_BIN_FIXTURE"
}

# --- helpers -----------------------------------------------------------------

plist_get() { # $1 = file, $2 = keypath → raw value on stdout; fails if absent
  if command -v plutil >/dev/null 2>&1; then
    plutil -extract "$2" raw -o - "$1"
  else
    python3 - "$1" "$2" <<'PY'
import plistlib, sys
d = plistlib.load(open(sys.argv[1], "rb"))
cur = d
for part in sys.argv[2].split("."):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        sys.exit(1)
if isinstance(cur, bool):
    print("true" if cur else "false")
else:
    print(cur)
PY
  fi
}

plist_lint() { # $1 = file
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint -s "$1"
  else
    python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$1"
  fi
}

render_broker() {
  "$RENDER" --agent broker --node-bin "$NODE_BIN_FIXTURE" "$@"
}

make_forbidden_stub() { # stub launchctl + security; logs any invocation
  local dir="$BATS_TEST_TMPDIR/forbidden-bin"
  mkdir -p "$dir"
  local tool
  for tool in launchctl security; do
    cat > "$dir/$tool" <<STUB
#!/bin/sh
echo "$tool \$*" >> "${FORBIDDEN_LOG:?}"
exit 0
STUB
    chmod +x "$dir/$tool"
  done
  printf '%s' "$dir"
}

# --- broker: positive ----------------------------------------------------------

@test "broker plist renders, lints, and asserts the Aqua defaults" {
  run render_broker
  [ "$status" -eq 0 ]
  [[ "$output" == *$'render\tbroker\t'*RENDERED* ]]
  plist="$AIBENDER_HOME/launchd/com.aibender.broker.plist"
  [ -f "$plist" ]
  plist_lint "$plist"
  [ "$(plist_get "$plist" Label)" = "com.aibender.broker" ]
  [ "$(plist_get "$plist" RunAtLoad)" = "true" ]
  [ "$(plist_get "$plist" KeepAlive.SuccessfulExit)" = "false" ]
  [ "$(plist_get "$plist" EnvironmentVariables.AIBENDER_HOME)" = "$AIBENDER_HOME" ]
  [ "$(plist_get "$plist" WorkingDirectory)" = "$AIBENDER_HOME" ]
}

@test "broker plist carries NO LimitLoadToSessionType (default = Aqua, blueprint §2)" {
  render_broker >/dev/null
  plist="$AIBENDER_HOME/launchd/com.aibender.broker.plist"
  run plist_get "$plist" LimitLoadToSessionType
  [ "$status" -ne 0 ]
  # and never a Background value anywhere in the rendered agent
  ! grep -q '<string>Background</string>' "$plist"
}

@test "broker plist is FINALIZED v1-ready (M6): frozen shape + packaged broker entry" {
  # M6 LaunchAgent-v1 finalization: the v1-ready shape is frozen and asserted
  # here so a drift is a test failure, not a silent regression. The agent is
  # NOT installed by any test (bootstrapping is the owner-gated v1 flip, T3).
  broker_entry="$BATS_TEST_TMPDIR/aibender-home/bin/aibender-core.mjs"
  run render_broker --broker-entry "$broker_entry"
  [ "$status" -eq 0 ]
  plist="$AIBENDER_HOME/launchd/com.aibender.broker.plist"
  plist_lint "$plist"
  # v1-ready invariants (all four together):
  [ "$(plist_get "$plist" RunAtLoad)" = "true" ]                    # start at GUI login
  [ "$(plist_get "$plist" KeepAlive.SuccessfulExit)" = "false" ]    # crash-restart, stay-down-on-clean-exit
  run plist_get "$plist" LimitLoadToSessionType                     # Aqua default (key ABSENT)
  [ "$status" -ne 0 ]
  # broker entry points at the packaged broker artifact the M6 bundle installs
  [ "$(plist_get "$plist" ProgramArguments.1)" = "$broker_entry" ]
  # and the template documents the M6 finalization + owner-gated flip
  grep -q 'FINALIZED v1-READY at M6' "$REPO_ROOT/infra/launchd/templates/com.aibender.broker.plist.template"
}

@test "broker render output points at gui/\$UID bootstrap and never Background" {
  run render_broker
  [ "$status" -eq 0 ]
  [[ "$output" == *'launchctl bootstrap gui/$UID'* ]]
  [[ "$output" == *"Owner-run"* ]]
  [[ "$output" != *"bootstrap user/"* ]]
}

@test "lms plist renders with lms server start under KeepAlive SuccessfulExit=false" {
  run "$RENDER" --agent lms --lms-bin "$LMS_BIN_FIXTURE"
  [ "$status" -eq 0 ]
  plist="$AIBENDER_HOME/launchd/com.aibender.lms.plist"
  plist_lint "$plist"
  [ "$(plist_get "$plist" Label)" = "com.aibender.lms" ]
  [ "$(plist_get "$plist" ProgramArguments.0)" = "$LMS_BIN_FIXTURE" ]
  [ "$(plist_get "$plist" ProgramArguments.1)" = "server" ]
  [ "$(plist_get "$plist" ProgramArguments.2)" = "start" ]
  [ "$(plist_get "$plist" KeepAlive.SuccessfulExit)" = "false" ]
}

# --- background variant: negative (expected-failure discipline) -----------------

@test "background variant is REFUSED without --acknowledge-expected-failure" {
  run "$RENDER" --agent broker-background-expected-fail --node-bin "$NODE_BIN_FIXTURE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"REFUSED"* ]]
  [[ "$output" == *"EXPECTED-FAILURE"* ]]
  [ ! -e "$AIBENDER_HOME/launchd/com.aibender.broker.background-expected-fail.plist" ]
}

@test "acknowledged background variant renders Background + expected-failure banner" {
  run "$RENDER" --agent broker-background-expected-fail --acknowledge-expected-failure
  [ "$status" -eq 0 ]
  plist="$AIBENDER_HOME/launchd/com.aibender.broker.background-expected-fail.plist"
  plist_lint "$plist"
  [ "$(plist_get "$plist" LimitLoadToSessionType)" = "Background" ]
  [ "$(plist_get "$plist" Label)" = "com.aibender.broker.background-expected-fail" ]
  [ "$(plist_get "$plist" KeepAlive)" = "false" ]
  [[ "$output" == *"EXPECTED-FAILURE PROBE"* ]]
  [[ "$output" == *"bootstrap user/"* ]]
  [[ "$output" == *"EXPECTED: dummy-value-exit=36"* ]]
}

@test "background probe command targets ONLY the harness-owned dummy item [X2]" {
  "$RENDER" --agent broker-background-expected-fail --acknowledge-expected-failure >/dev/null
  plist="$AIBENDER_HOME/launchd/com.aibender.broker.background-expected-fail.plist"
  probe="$(plist_get "$plist" ProgramArguments.2)"
  [[ "$probe" == *"aibender-probe-dummy"* ]]
  [[ "$probe" != *"Claude Code-credentials"* ]]
  # every -s flag in the probe names the dummy service
  ! printf '%s' "$probe" | grep -qE '\-s +[^a]'
}

# --- edge --------------------------------------------------------------------

@test "re-render is idempotent (UNCHANGED, byte-identical)" {
  render_broker >/dev/null
  plist="$AIBENDER_HOME/launchd/com.aibender.broker.plist"
  before="$(cat "$plist")"
  run render_broker
  [ "$status" -eq 0 ]
  [[ "$output" == *$'\tUNCHANGED'* ]]
  [ "$(cat "$plist")" = "$before" ]
}

@test "dry-run lints but writes nothing" {
  run render_broker --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"DRY-RUN"* ]]
  [ ! -e "$AIBENDER_HOME" ]
}

@test "path containing XML-hostile characters (&, <) renders a linting plist" {
  hostile="$BATS_TEST_TMPDIR/we&like<xml>"
  mkdir -p "$hostile"
  run "$RENDER" --agent broker --home "$hostile" --node-bin "$NODE_BIN_FIXTURE"
  [ "$status" -eq 0 ]
  plist="$hostile/launchd/com.aibender.broker.plist"
  plist_lint "$plist"
  [ "$(plist_get "$plist" WorkingDirectory)" = "$hostile" ]
}

@test "relative AIBENDER_HOME is rejected (byte-stability guard)" {
  run env AIBENDER_HOME="rel/home" "$RENDER" --agent broker --node-bin "$NODE_BIN_FIXTURE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"absolute path"* ]]
}

@test "render never EXECUTES launchctl or security (runtime stub proof)" {
  stub_dir="$(FORBIDDEN_LOG="$BATS_TEST_TMPDIR/forbidden.log" make_forbidden_stub)"
  export FORBIDDEN_LOG="$BATS_TEST_TMPDIR/forbidden.log"
  : > "$FORBIDDEN_LOG"
  run env PATH="$stub_dir:$PATH" "$RENDER" --agent broker --node-bin "$NODE_BIN_FIXTURE"
  [ "$status" -eq 0 ]
  run env PATH="$stub_dir:$PATH" "$RENDER" --agent lms --lms-bin "$LMS_BIN_FIXTURE"
  [ "$status" -eq 0 ]
  run env PATH="$stub_dir:$PATH" "$RENDER" --agent broker-background-expected-fail --acknowledge-expected-failure
  [ "$status" -eq 0 ]
  [ ! -s "$FORBIDDEN_LOG" ]
}

@test "unknown agent name dies with the sanctioned list" {
  run "$RENDER" --agent chaos-monkey
  [ "$status" -eq 1 ]
  [[ "$output" == *"unknown --agent"* ]]
}
