#!/usr/bin/env bats
# hooks.bats — SI-3 per-account hook settings + statusline tee tests.
#
# Plan §9.2 SI-3 row:
#   positive — hook templates install idempotently (plus: fragment matches
#              the FROZEN-M2 hooks-contract.md — 29-event vocabulary, http
#              POSTs to /hooks/v1/<LABEL>, label-only per-account delta;
#              M4: the [X4] slots are ACTIVE per the §7.1 routing amendment
#              — SessionStart response window + state-file record + clean
#              upgrade from an M2/M3-era install)
#   negative — invalid settings.json REFUSED and untouched (fail closed);
#              unmanaged dir (no provenance marker) REFUSED; hook entries
#              are http-only (no shell-outs — hooks-contract §5.3 [X2])
#   edge     — install/re-install/uninstall against fixture settings.json
#              trees preserves unrelated user settings exactly
#
# Fully headless: temp $AIBENDER_HOME provisioned via the SI-2 script;
# fixtures synthesized (placeholder labels only [X2]). Live install into
# the real account dirs is T3 (docs/runbooks/hooks-telemetry.md).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  HOOKS="$REPO_ROOT/infra/hooks"
  INSTALL="$HOOKS/install-hook-settings.sh"
  UNINSTALL="$HOOKS/uninstall-hook-settings.sh"
  STATUSLINE="$HOOKS/statusline/aibender-statusline.sh"
  PROVISION="$REPO_ROOT/infra/scripts/accounts/provision-accounts.sh"
  export AIBENDER_HOME="$BATS_TEST_TMPDIR/aibhome"
  unset AIBENDER_HOOKS_PORT AIBENDER_OTLP_PORT 2>/dev/null || true
}

provision() { "$PROVISION" >/dev/null; }

perms() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

settings_of() { printf '%s/accounts/%s/settings.json' "$AIBENDER_HOME" "$1"; }

# A synthesized statusline render tick (observability findings shape) [X2].
statusline_fixture() {
  cat <<'EOF'
{"session_id":"synthetic-0001","model":{"id":"claude-fixture","display_name":"Fixture"},"cwd":"/tmp/fixture","cost":{"total_cost_usd":0.0123},"context_window":{"used_percentage":33.3},"rate_limits":{"five_hour":{"used_percentage":41.5,"resets_at":"2026-07-04T12:00:00Z"},"seven_day":{"used_percentage":12,"resets_at":"2026-07-08T00:00:00Z"}}}
EOF
}

# A fixture settings.json with realistic unrelated user content [X2].
user_settings_fixture() {
  cat <<'EOF'
{
  "model": "opus",
  "permissions": { "allow": ["Bash(ls:*)"], "deny": ["WebFetch"] },
  "env": { "MY_CUSTOM_FLAG": "1", "OTEL_LOG_USER_PROMPTS": "0" },
  "statusLine": { "type": "command", "command": "/usr/local/bin/my-own-status.sh --fast" },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo user-hook" } ] }
    ]
  },
  "somethingUnknown": { "keep": true }
}
EOF
}

# --- install: positive -----------------------------------------------------------

@test "fresh install writes the frozen-contract fragment for all provisioned accounts" {
  provision
  run "$INSTALL"
  [ "$status" -eq 0 ]
  for pair in "max-a MAX_A" "max-b MAX_B" "ent ENT"; do
    set -- $pair
    s="$(settings_of "$1")"
    [ -f "$s" ]
    [ "$(perms "$s")" = "600" ]
    # 29-event vocabulary (hooks-contract.md §3)
    [ "$(jq '.hooks | length' "$s")" -eq 29 ]
    # every registered hook is an http POST to this account's /hooks/v1/ URL
    [ "$(jq -r '[.hooks[][].hooks[].type] | unique | join(",")' "$s")" = "http" ]
    [ "$(jq -r '[.hooks[][].hooks[].url] | unique | join(",")' "$s")" = "http://127.0.0.1:4319/hooks/v1/$2" ]
    # short timeouts everywhere (fire-and-forget posture)
    [ "$(jq '[.hooks[][].hooks[].timeout] | max' "$s")" -le 10 ]
    # OTel env block (blueprint §6.1)
    [ "$(jq -r '.env.CLAUDE_CODE_ENABLE_TELEMETRY' "$s")" = "1" ]
    [ "$(jq -r '.env.OTEL_EXPORTER_OTLP_ENDPOINT' "$s")" = "http://127.0.0.1:4318" ]
    [ "$(jq -r '.env.OTEL_LOG_TOOL_DETAILS' "$s")" = "1" ]
    [ "$(jq -r '.env.OTEL_RESOURCE_ATTRIBUTES' "$s")" = "account=$2" ]
    [ "$(jq -r '.env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID' "$s")" = "false" ]
    # statusline tee registered against the machine-local copy
    [[ "$(jq -r '.statusLine.command' "$s")" == *"$AIBENDER_HOME/bin/aibender-statusline.sh"* ]]
    [[ "$(jq -r '.statusLine.command' "$s")" == *"--label '$2'"* ]]
    # state file for surgical uninstall
    [ -f "$AIBENDER_HOME/accounts/$1/.aibender-hooks.json" ]
  done
  [ -x "$AIBENDER_HOME/bin/aibender-statusline.sh" ]
  [ -d "$AIBENDER_HOME/quota" ]
  [ "$(perms "$AIBENDER_HOME/quota")" = "700" ]
}

@test "the ONLY per-account difference in hook URLs is the label segment (contract §5.1)" {
  provision
  "$INSTALL" >/dev/null
  ua="$(jq -r '.hooks.SessionEnd[0].hooks[0].url' "$(settings_of max-a)")"
  ub="$(jq -r '.hooks.SessionEnd[0].hooks[0].url' "$(settings_of max-b)")"
  [ "${ua%MAX_A}" = "${ub%MAX_B}" ]
  [ "$ua" != "$ub" ]
}

@test "[X4] automation slots ride the same envelope: SessionStart/SessionEnd/PreCompact" {
  provision
  "$INSTALL" >/dev/null
  s="$(settings_of max-a)"
  [ "$(jq -r '.hooks.SessionStart[0].matcher' "$s")" = "startup|resume|clear|compact" ]
  [ "$(jq '.hooks.SessionEnd | length' "$s")" -eq 1 ]
  [ "$(jq '.hooks.PreCompact | length' "$s")" -eq 1 ]
  url="$(jq -r '.hooks.PreCompact[0].hooks[0].url' "$s")"
  [[ "$url" == "http://127.0.0.1:4319/hooks/v1/MAX_A" ]]
}

# --- [X4] M4 activation (hooks-contract.md §7.1 routing amendment) ---------------

@test "[X4] M4: SessionStart carries the widened response window; SessionEnd/PreCompact stay fire-and-forget" {
  provision
  "$INSTALL" >/dev/null
  for a in max-a max-b ent; do
    s="$(settings_of "$a")"
    # SessionStart's 200 response is the frozen brief injection
    # (hookSpecificOutput.additionalContext) — give the collector's
    # deadline race room to answer before the CLI-side hook timeout.
    [ "$(jq '.hooks.SessionStart[0].hooks[0].timeout' "$s")" -eq 10 ]
    # the fire-and-forget slots keep the short window (collector answers
    # 204 FIRST, handler runs post-ack — §7.1)
    [ "$(jq '.hooks.SessionEnd[0].hooks[0].timeout' "$s")" -eq 5 ]
    [ "$(jq '.hooks.PreCompact[0].hooks[0].timeout' "$s")" -eq 5 ]
  done
  # the committed template pins the same split
  [ "$(jq '.hooks.SessionStart[0].hooks[0].timeout' "$HOOKS/templates/settings.fragment.json.template")" -eq 10 ]
  # activation adds NO second transport: SessionStart stays ONE plain http
  # POST — the injection rides the RESPONSE (same envelope, §7.1)
  [ "$(jq '.hooks.SessionStart[0].hooks | length' "$(settings_of max-a)")" -eq 1 ]
  [ "$(jq -r '.hooks.SessionStart[0].hooks[0].type' "$(settings_of max-a)")" = "http" ]
}

@test "[X4] M4: state file records the activation (slots + SessionStart response contract)" {
  provision
  "$INSTALL" --label MAX_A >/dev/null
  st="$AIBENDER_HOME/accounts/max-a/.aibender-hooks.json"
  [ "$(jq -r '.x4.slots | join(",")' "$st")" = "SessionEnd,PreCompact,SessionStart" ]
  [ "$(jq -r '.x4.sessionStart.matcher' "$st")" = "startup|resume|clear|compact" ]
  [ "$(jq '.x4.sessionStart.timeoutSeconds' "$st")" -eq 10 ]
  [[ "$(jq -r '.x4.sessionStart.responseApplied' "$st")" == *"additionalContext"* ]]
  # honest posture: injection is 204-default until the T3 pinned-CLI proof
  [[ "$(jq -r '.x4.injectionDefault' "$st")" == *"204"* ]]
  # the record is DERIVED from the installed settings — assert lockstep
  [ "$(jq '.x4.sessionStart.timeoutSeconds' "$st")" -eq "$(jq '.hooks.SessionStart[0].hooks[0].timeout' "$(settings_of max-a)")" ]
}

@test "[X4] M4: upgrade from an M2/M3-era install replaces aibender slots in place (no dupes, user settings kept)" {
  provision
  user_settings_fixture > "$(settings_of max-a)"
  "$INSTALL" --label MAX_A >/dev/null
  s="$(settings_of max-a)"
  # simulate the M2/M3-era tree: aibender SessionStart entry at the old 5 s window
  jq '.hooks.SessionStart[0].hooks[0].timeout = 5' "$s" > "$s.tmp" && mv "$s.tmp" "$s"
  run "$INSTALL" --label MAX_A
  [ "$status" -eq 0 ]
  [[ "$output" == *$'hooks\tMAX_A\t'*$'\tINSTALLED'* ]]
  [ "$(jq '.hooks.SessionStart | length' "$s")" -eq 1 ]
  [ "$(jq '.hooks.SessionStart[0].hooks[0].timeout' "$s")" -eq 10 ]
  # hostile fixture survives the upgrade pass untouched
  [ "$(jq -r '.model' "$s")" = "opus" ]
  [ "$(jq -r '.somethingUnknown.keep' "$s")" = "true" ]
  [ "$(jq '.hooks.PreToolUse | length' "$s")" -eq 2 ]
  [ "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$s")" = "echo user-hook" ]
  # and a further re-run is byte-stable
  before="$(cat "$s")"
  "$INSTALL" --label MAX_A >/dev/null
  [ "$(cat "$s")" = "$before" ]
}

@test "[X4] M4: uninstall removes the activated slots and the x4 state record with them" {
  provision
  "$INSTALL" --label MAX_B >/dev/null
  st="$AIBENDER_HOME/accounts/max-b/.aibender-hooks.json"
  [ "$(jq -r '.x4.slots[2]' "$st")" = "SessionStart" ]
  run "$UNINSTALL" --label MAX_B
  [ "$status" -eq 0 ]
  [ ! -e "$(settings_of max-b)" ]
  [ ! -e "$st" ]
}

@test "install is idempotent (second run UNCHANGED, byte-identical)" {
  provision
  "$INSTALL" >/dev/null
  before="$(cat "$(settings_of max-a)")"
  run "$INSTALL"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'hooks\tMAX_A\t'*$'\tUNCHANGED'* ]]
  [[ "$output" != *$'hooks\tMAX_A\t'*$'\tINSTALLED'* ]]
  [ "$(cat "$(settings_of max-a)")" = "$before" ]
}

@test "custom --hooks-port and AIBENDER_HOOKS_PORT are honored" {
  provision
  "$INSTALL" --label MAX_A --hooks-port 5555 >/dev/null
  [ "$(jq -r '.hooks.Stop[0].hooks[0].url' "$(settings_of max-a)")" = "http://127.0.0.1:5555/hooks/v1/MAX_A" ]
  run env AIBENDER_HOOKS_PORT=6666 "$INSTALL" --label MAX_B
  [ "$status" -eq 0 ]
  [ "$(jq -r '.hooks.Stop[0].hooks[0].url' "$(settings_of max-b)")" = "http://127.0.0.1:6666/hooks/v1/MAX_B" ]
}

@test "install --dry-run reports the plan and writes nothing" {
  provision
  run "$INSTALL" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"DRY-RUN"* ]]
  [ ! -e "$(settings_of max-a)" ]
  [ ! -e "$AIBENDER_HOME/bin" ]
}

# --- install: negative -----------------------------------------------------------

@test "invalid settings.json is REFUSED, exit 1, file untouched; others still install" {
  provision
  printf 'this is { not json' > "$(settings_of max-a)"
  run "$INSTALL"
  [ "$status" -eq 1 ]
  [[ "$output" == *$'hooks\tMAX_A\t'*REFUSED* ]]
  [ "$(cat "$(settings_of max-a)")" = "this is { not json" ]
  [ -f "$(settings_of max-b)" ]
  [ "$(jq '.hooks | length' "$(settings_of max-b)")" -eq 29 ]
}

@test "dir without the SI-2 provenance marker is REFUSED (unmanaged dir guard)" {
  provision
  rm "$AIBENDER_HOME/accounts/ent/.aibender-account.json"
  run "$INSTALL" --label ENT
  [ "$status" -eq 1 ]
  [[ "$output" == *$'hooks\tENT\t'*REFUSED* ]]
  [ ! -e "$(settings_of ent)" ]
}

@test "unknown --label dies (labels come from the profile manifests only [X2])" {
  provision
  run "$INSTALL" --label AWS_DEV
  [ "$status" -eq 1 ]
  [[ "$output" == *"no profile matched"* ]]
}

@test "installed hooks contain NO shell-outs — http only (hooks-contract §5.3 [X2])" {
  provision
  "$INSTALL" >/dev/null
  for a in max-a max-b ent; do
    [ "$(jq '[.hooks[][].hooks[] | select(.type != "http")] | length' "$(settings_of "$a")")" -eq 0 ]
  done
  # and the committed template itself registers no command hooks
  [ "$(jq '[.hooks[][].hooks[] | select(.type != "http")] | length' "$HOOKS/templates/settings.fragment.json.template")" -eq 0 ]
}

# --- edge: merge fidelity (plan §9.2 SI-3 edge row) --------------------------------

@test "install into a populated settings.json preserves every unrelated user setting" {
  provision
  user_settings_fixture > "$(settings_of max-a)"
  run "$INSTALL" --label MAX_A
  [ "$status" -eq 0 ]
  s="$(settings_of max-a)"
  [ "$(jq -r '.model' "$s")" = "opus" ]
  [ "$(jq -r '.permissions.allow[0]' "$s")" = "Bash(ls:*)" ]
  [ "$(jq -r '.permissions.deny[0]' "$s")" = "WebFetch" ]
  [ "$(jq -r '.somethingUnknown.keep' "$s")" = "true" ]
  [ "$(jq -r '.env.MY_CUSTOM_FLAG' "$s")" = "1" ]
  [ "$(jq -r '.env.OTEL_LOG_USER_PROMPTS' "$s")" = "0" ]
  # user's command hook survives, ours is appended alongside
  [ "$(jq '.hooks.PreToolUse | length' "$s")" -eq 2 ]
  [ "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$s")" = "echo user-hook" ]
  [ "$(jq -r '.hooks.PreToolUse[1].hooks[0].type' "$s")" = "http" ]
}

@test "pre-existing user statusline is captured as a passthrough and keeps rendering" {
  provision
  user_settings_fixture > "$(settings_of max-a)"
  "$INSTALL" --label MAX_A >/dev/null
  pt="$AIBENDER_HOME/accounts/max-a/.aibender-statusline-passthrough.sh"
  [ -x "$pt" ]
  grep -q 'my-own-status.sh --fast' "$pt"
  [ "$(perms "$pt")" = "700" ]
  # ours is now the registered statusline and points at the passthrough
  [[ "$(jq -r '.statusLine.command' "$(settings_of max-a)")" == *"--passthrough '$pt'"* ]]
}

@test "re-install after the user adds a new hook keeps the user hook (no clobber, no dupes)" {
  provision
  "$INSTALL" --label MAX_A >/dev/null
  s="$(settings_of max-a)"
  jq '.hooks.SessionEnd += [{"hooks":[{"type":"command","command":"echo user-added-later"}]}]' "$s" > "$s.tmp" && mv "$s.tmp" "$s"
  run "$INSTALL" --label MAX_A
  [ "$status" -eq 0 ]
  [ "$(jq '.hooks.SessionEnd | length' "$s")" -eq 2 ]
  [ "$(jq '[.hooks.SessionEnd[].hooks[] | select(.type == "http")] | length' "$s")" -eq 1 ]
  [ "$(jq -r '[.hooks.SessionEnd[].hooks[] | select(.type == "command")][0].command' "$s")" = "echo user-added-later" ]
  # and a further re-run is stable
  before="$(cat "$s")"
  "$INSTALL" --label MAX_A >/dev/null
  [ "$(cat "$s")" = "$before" ]
}

@test "install → uninstall round-trips a populated settings.json to semantic identity" {
  provision
  user_settings_fixture > "$(settings_of max-a)"
  orig_norm="$(jq -S . "$(settings_of max-a)")"
  "$INSTALL" --label MAX_A >/dev/null
  run "$UNINSTALL" --label MAX_A
  [ "$status" -eq 0 ]
  [[ "$output" == *$'unhook\tMAX_A\t'*REMOVED* ]]
  [ "$(jq -S . "$(settings_of max-a)")" = "$orig_norm" ]
  [ ! -e "$AIBENDER_HOME/accounts/max-a/.aibender-statusline-passthrough.sh" ]
  [ ! -e "$AIBENDER_HOME/accounts/max-a/.aibender-hooks.json" ]
}

@test "uninstall deletes a settings.json that only ever held aibender keys" {
  provision
  "$INSTALL" --label MAX_B >/dev/null
  [ -f "$(settings_of max-b)" ]
  run "$UNINSTALL" --label MAX_B
  [ "$status" -eq 0 ]
  [ ! -e "$(settings_of max-b)" ]
}

@test "uninstall leaves a user-edited OTel value in place and warns" {
  provision
  "$INSTALL" --label MAX_A >/dev/null
  s="$(settings_of max-a)"
  jq '.env.OTEL_LOG_TOOL_DETAILS = "0"' "$s" > "$s.tmp" && mv "$s.tmp" "$s"
  run "$UNINSTALL" --label MAX_A
  [ "$status" -eq 0 ]
  [ "$(jq -r '.env.OTEL_LOG_TOOL_DETAILS' "$s")" = "0" ]
  [ "$(jq -r '.env.CLAUDE_CODE_ENABLE_TELEMETRY // "gone"' "$s")" = "gone" ]
  [[ "$output" == *"left untouched"* ]]
}

@test "uninstall on a never-installed populated dir is CLEAN and does not rewrite the file" {
  provision
  user_settings_fixture > "$(settings_of ent)"
  before="$(cat "$(settings_of ent)")"
  run "$UNINSTALL" --label ENT
  [ "$status" -eq 0 ]
  [[ "$output" == *$'unhook\tENT\t'*CLEAN* ]]
  [ "$(cat "$(settings_of ent)")" = "$before" ]
}

@test "uninstall without a state file still removes by marker (with a warning)" {
  provision
  user_settings_fixture > "$(settings_of max-a)"
  orig_norm="$(jq -S . "$(settings_of max-a)")"
  "$INSTALL" --label MAX_A >/dev/null
  rm "$AIBENDER_HOME/accounts/max-a/.aibender-hooks.json"
  run "$UNINSTALL" --label MAX_A
  [ "$status" -eq 0 ]
  [[ "$output" == *"no state file"* ]]
  s="$(settings_of max-a)"
  # aibender hooks + env gone; user content intact
  [ "$(jq '[.hooks[][].hooks[] | select(.type == "http")] | length' "$s")" -eq 0 ]
  [ "$(jq -r '.env.CLAUDE_CODE_ENABLE_TELEMETRY // "gone"' "$s")" = "gone" ]
  [ "$(jq -r '.env.MY_CUSTOM_FLAG' "$s")" = "1" ]
  # without state the captured original statusline cannot be restored — ours
  # is removed entirely (documented) and the user fixture line differs there
  [ "$(jq -r '.statusLine // "absent"' "$s")" = "absent" ]
  [ "$(jq -Sr 'del(.statusLine)' "$s")" = "$(printf '%s' "$orig_norm" | jq -Sr 'del(.statusLine)')" ]
}

@test "uninstall --purge-shared removes the statusline tee and quota files" {
  provision
  "$INSTALL" >/dev/null
  printf '{}' > "$AIBENDER_HOME/quota/MAX_A.json"
  run "$UNINSTALL" --purge-shared
  [ "$status" -eq 0 ]
  [ ! -e "$AIBENDER_HOME/bin/aibender-statusline.sh" ]
  [ ! -e "$AIBENDER_HOME/quota" ]
}

# --- statusline tee ---------------------------------------------------------------

@test "statusline tees stdin verbatim to the 0600 quota file and prints an instrument line" {
  qf="$AIBENDER_HOME/quota/MAX_A.json"
  payload="$(statusline_fixture)"
  out="$(printf '%s' "$payload" | "$STATUSLINE" --label MAX_A --quota-file "$qf")"
  [ -f "$qf" ]
  [ "$(perms "$qf")" = "600" ]
  [ "$(cat "$qf")" = "$payload" ]
  [[ "$out" == *"MAX_A"* ]]
  [[ "$out" == *"5h:41.5%"* ]]
  [[ "$out" == *"7d:12%"* ]]
  # atomic publish: no tmp remnants
  [ -z "$(find "$AIBENDER_HOME/quota" -name '*.tmp' -print 2>/dev/null)" ]
}

@test "statusline passthrough runs the captured user command with the same stdin" {
  qf="$AIBENDER_HOME/quota/MAX_B.json"
  pt="$BATS_TEST_TMPDIR/passthrough.sh"
  printf '#!/usr/bin/env bash\n# aibender-passthrough\nread -r _line || true\necho "USER LINE"\n' > "$pt"
  chmod 700 "$pt"
  out="$(statusline_fixture | "$STATUSLINE" --label MAX_B --quota-file "$qf" --passthrough "$pt")"
  [ "$out" = "USER LINE" ]
  [ -f "$qf" ]
}

@test "statusline NEVER breaks the render tick: malformed stdin still exits 0 with a line" {
  qf="$AIBENDER_HOME/quota/ENT.json"
  run bash -c "printf 'not json at all' | '$STATUSLINE' --label ENT --quota-file '$qf'"
  [ "$status" -eq 0 ]
  [ "$output" = "ENT" ]
  [ "$(cat "$qf")" = "not json at all" ]
}

@test "statusline with an unwritable quota path still exits 0 and prints" {
  run bash -c "statusline_json='{\"rate_limits\":{}}'; printf '%s' \"\$statusline_json\" | '$STATUSLINE' --label MAX_A --quota-file /dev/null/nope/MAX_A.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"MAX_A"* ]]
}
