#!/usr/bin/env bash
# uninstall-hook-settings.sh — SI-3 per-account hook settings uninstaller.
#
# Surgically removes exactly what install-hook-settings.sh added and
# NOTHING else (plan §9.2 SI-3 edge row — unrelated user settings survive
# round-trip untouched):
#
#   hooks       — every aibender-owned entry (all-http, loopback /hooks/v1/
#                 URLs); user hook entries stay. Emptied event arrays and an
#                 emptied hooks object are pruned.
#   statusLine  — removed only if it is OURS (command references
#                 aibender-statusline.sh); a captured pre-install statusline
#                 (state file .aibender-hooks.json) is restored verbatim.
#   env         — each key removed only if its CURRENT value equals what we
#                 installed (state file; else recomputed for this label) —
#                 a user-edited value is left alone with a warning.
#
# The per-account state file and passthrough snippet are removed. The quota
# tee under $AIBENDER_HOME/{bin,quota} is shared machine state and is left
# in place unless --purge-shared is passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/hooks/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
usage: uninstall-hook-settings.sh [--home DIR] [--profiles-dir DIR] [--label LABEL]
                                  [--otlp-port N] [--purge-shared] [--dry-run]

Removes the aibender hook/statusline/OTel settings from each account's
settings.json, preserving all user settings. --purge-shared also removes
the shared statusline tee binary ($AIBENDER_HOME/bin) and quota files.
EOF
}

HOME_OVERRIDE=""
PROFILES_DIR=""
ONLY_LABEL=""
OTLP_PORT="${AIBENDER_OTLP_PORT:-$AIB_DEFAULT_OTLP_PORT}"
PURGE_SHARED=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_OVERRIDE="${2:?--home needs a value}"; shift 2 ;;
    --profiles-dir) PROFILES_DIR="${2:?--profiles-dir needs a value}"; shift 2 ;;
    --label) ONLY_LABEL="${2:?--label needs a value}"; shift 2 ;;
    --otlp-port) OTLP_PORT="${2:?--otlp-port needs a value}"; shift 2 ;;
    --purge-shared) PURGE_SHARED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; aib_die "unknown argument: $1" ;;
  esac
done

aib_require_cmds jq
aib_port_validate "--otlp-port" "$OTLP_PORT"
AIB_HOME="$(aib_home_resolve "$HOME_OVERRIDE")"
[ -n "$PROFILES_DIR" ] || PROFILES_DIR="$(aib_default_profiles_dir "$SCRIPT_DIR/../scripts/accounts")"
OTLP_ENDPOINT="$(aib_otlp_endpoint "$OTLP_PORT")"

FAILED=0

uninstall_account() { # $1 = label, $2 = dir
  local label="$1" dir="$2"
  local settings state_file passthrough env_expected original_sl cleaned before

  settings="$dir/settings.json"
  state_file="$dir/$AIB_HOOKS_STATE_NAME"
  passthrough="$dir/$AIB_PASSTHROUGH_NAME"

  if [ ! -d "$dir" ] || [ ! -f "$settings" ]; then
    printf 'unhook\t%s\t%s\tCLEAN (nothing installed)\n' "$label" "$dir"
    return 0
  fi

  if ! jq -e 'type == "object"' "$settings" >/dev/null 2>&1; then
    printf 'unhook\t%s\t%s\tREFUSED (settings.json is not a JSON object; nothing touched)\n' "$label" "$dir"
    FAILED=1
    return 0
  fi

  # What we believe we installed: the state file is authoritative; without it
  # we recompute the env block for this label (a custom --otlp-port used at
  # install time must be repeated here, else those keys are left behind).
  if [ -f "$state_file" ] && jq -e '.env | type == "object"' "$state_file" >/dev/null 2>&1; then
    env_expected="$(jq -c '.env' "$state_file")"
    original_sl="$(jq -c '.originalStatusLine // null' "$state_file")"
  else
    [ -f "$state_file" ] || aib_warn "$label: no state file ($state_file) — removing by marker; re-run with matching ports if OTel keys remain"
    env_expected="$(aib_env_json "$label" "$OTLP_ENDPOINT" | jq -c .)"
    original_sl="null"
  fi

  cleaned="$(jq -S --argjson expected "$env_expected" --argjson orig "$original_sl" "
    $AIB_JQ_PRELUDE
    # 1. hooks: drop aibender entries, prune empties
    (if has(\"hooks\") then
       .hooks |= with_entries(.value |= (if type == \"array\" then map(select(aib_is_hook_entry | not)) else . end))
       | .hooks |= with_entries(select((.value | type != \"array\") or ((.value | length) > 0)))
       | (if (.hooks | length) == 0 then del(.hooks) else . end)
     else . end)
    # 2. statusLine: only if ours; restore the captured original if any
    | (if has(\"statusLine\") and ((.statusLine.command? // \"\") | contains(\"aibender-statusline.sh\"))
       then (if \$orig == null then del(.statusLine) else .statusLine = \$orig end)
       else . end)
    # 3. env: remove keys whose current value is exactly what we installed
    | (if has(\"env\") then
         .env |= with_entries(select((\$expected[.key] == null) or (\$expected[.key] != .value)))
         | (if (.env | length) == 0 then del(.env) else . end)
       else . end)
  " "$settings")"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'unhook\t%s\t%s\tDRY-RUN (would remove aibender hooks/statusline/OTel keys)\n' "$label" "$dir"
    return 0
  fi

  before="$(jq -S . "$settings")"   # semantic compare — never rewrite a file we change nothing in
  if [ "$cleaned" = "{}" ]; then
    rm -f "$settings"
    printf 'unhook\t%s\t%s\tREMOVED (settings.json empty after cleanup — deleted)\n' "$label" "$dir"
  elif [ "$cleaned" = "$before" ]; then
    printf 'unhook\t%s\t%s\tCLEAN (no aibender keys present)\n' "$label" "$dir"
  else
    printf '%s\n' "$cleaned" | aib_write_600 "$settings"
    printf 'unhook\t%s\t%s\tREMOVED\n' "$label" "$dir"
  fi

  # Passthrough snippet: only remove a file we created (marker check).
  if [ -f "$passthrough" ] && grep -q '# aibender-passthrough' "$passthrough" 2>/dev/null; then
    rm -f "$passthrough"
  fi
  rm -f "$state_file"

  # Leftover OTel keys the user edited stay put — surface them honestly.
  if [ -f "$settings" ] && jq -e '.env? // {} | keys | any(startswith("OTEL_") or . == "CLAUDE_CODE_ENABLE_TELEMETRY")' "$settings" >/dev/null 2>&1; then
    aib_warn "$label: OTel-ish env keys remain in $settings (values differ from what aibender installed — left untouched)"
  fi
  return 0
}

FOUND=0
while IFS= read -r manifest; do
  [ -n "$manifest" ] || continue
  resolved="$(aib_profile_resolve "$manifest" "$AIB_HOME")"
  label="${resolved%%$'\t'*}"
  dir="${resolved#*$'\t'}"
  if [ -n "$ONLY_LABEL" ] && [ "$label" != "$ONLY_LABEL" ]; then
    continue
  fi
  FOUND=1
  uninstall_account "$label" "$dir"
done <<EOF_MANIFESTS
$(aib_profile_files "$PROFILES_DIR")
EOF_MANIFESTS

[ "$FOUND" -eq 1 ] || aib_die "no profile matched${ONLY_LABEL:+ label $ONLY_LABEL} in $PROFILES_DIR"

if [ "$PURGE_SHARED" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  rm -f "$AIB_HOME/bin/aibender-statusline.sh"
  rm -rf "$AIB_HOME/quota"
  printf 'unhook\t-\t%s\tPURGED (statusline tee + quota files)\n' "$AIB_HOME"
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0
