#!/usr/bin/env bash
# install-hook-settings.sh — SI-3 per-account hook settings installer.
#
# For every account profile (infra/profiles/*.profile.json — MAX_A/MAX_B/ENT
# [X2]) this MERGES the rendered settings fragment
# (templates/settings.fragment.json.template) into
# <CLAUDE_CONFIG_DIR>/settings.json:
#
#   env         — the OTel block (blueprint §6.1): telemetry on, OTLP to
#                 127.0.0.1:<otlp-port>, OTEL_LOG_TOOL_DETAILS=1,
#                 OTEL_RESOURCE_ATTRIBUTES=account=<LABEL>, account-UUID
#                 attribution off. Only OUR keys are written; every other
#                 env key is preserved.
#   statusLine  — the quota tee (statusline/aibender-statusline.sh, copied
#                 to $AIBENDER_HOME/bin/). A pre-existing user statusline is
#                 captured into a passthrough snippet and keeps producing
#                 the visible line; ours only adds the tee.
#   hooks       — the FROZEN-M2 hooks-contract.md vocabulary (~30 events),
#                 each a type:"http" POST to
#                 http://127.0.0.1:<hooks-port>/hooks/v1/<LABEL> with a
#                 short timeout. The [X4] automation events
#                 (SessionStart/SessionEnd/PreCompact) ride the SAME
#                 envelope (hooks-contract.md §5.4); at M4 the slots are
#                 ACTIVE per the §7.1 routing amendment — SessionEnd and
#                 PreCompact stay fire-and-forget (5 s), while SessionStart
#                 carries a widened response window (10 s) because its `200`
#                 response is the frozen brief-injection shape
#                 (hookSpecificOutput.additionalContext) the CLI applies as
#                 hook output. Injection stays 204-default collector-side
#                 until the T3 pinned-CLI verification lands. User hook
#                 entries are preserved; aibender entries (loopback
#                 /hooks/v1/ POSTs) are replaced in place — idempotent by
#                 construction, so an M2/M3-era install upgrades cleanly.
#
# MERGE, NEVER OVERWRITE (plan §9.2 SI-3 edge row): unknown keys, user
# permissions, user hooks, user env all survive. Invalid existing JSON is
# REFUSED and left untouched (fail closed). Re-running is byte-stable.
#
# Headless-safe: writes only under $AIBENDER_HOME and the account config
# dirs it manages (provenance-marker checked). Installing into the REAL
# account dirs is T3, owner-run — docs/runbooks/hooks-telemetry.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/hooks/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
usage: install-hook-settings.sh [--home DIR] [--profiles-dir DIR] [--label LABEL]
                                [--hooks-port N] [--otlp-port N] [--dry-run]

Merges the aibender hook/statusline/OTel settings fragment into each
account's settings.json. Idempotent; preserves unrelated user settings.
Ports default to 4319 (AIBENDER_HOOKS_PORT) and 4318 (AIBENDER_OTLP_PORT).
EOF
}

HOME_OVERRIDE=""
PROFILES_DIR=""
ONLY_LABEL=""
HOOKS_PORT="${AIBENDER_HOOKS_PORT:-$AIB_DEFAULT_HOOKS_PORT}"
OTLP_PORT="${AIBENDER_OTLP_PORT:-$AIB_DEFAULT_OTLP_PORT}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_OVERRIDE="${2:?--home needs a value}"; shift 2 ;;
    --profiles-dir) PROFILES_DIR="${2:?--profiles-dir needs a value}"; shift 2 ;;
    --label) ONLY_LABEL="${2:?--label needs a value}"; shift 2 ;;
    --hooks-port) HOOKS_PORT="${2:?--hooks-port needs a value}"; shift 2 ;;
    --otlp-port) OTLP_PORT="${2:?--otlp-port needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; aib_die "unknown argument: $1" ;;
  esac
done

aib_require_cmds jq
aib_port_validate "--hooks-port" "$HOOKS_PORT"
aib_port_validate "--otlp-port" "$OTLP_PORT"
[ -f "$AIB_HOOKS_TEMPLATE" ] || aib_die "settings fragment template missing: $AIB_HOOKS_TEMPLATE"
[ -f "$AIB_STATUSLINE_SRC" ] || aib_die "statusline script missing: $AIB_STATUSLINE_SRC"

AIB_HOME="$(aib_home_resolve "$HOME_OVERRIDE")"
[ -n "$PROFILES_DIR" ] || PROFILES_DIR="$(aib_default_profiles_dir "$SCRIPT_DIR/../scripts/accounts")"

OTLP_ENDPOINT="$(aib_otlp_endpoint "$OTLP_PORT")"
STATUSLINE_BIN="$AIB_HOME/bin/aibender-statusline.sh"
aib_no_squote "AIBENDER_HOME" "$AIB_HOME"

# ---- shared machine-local pieces (once, not per account) ----------------------

install_statusline_bin() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'hooks\t-\t%s\tDRY-RUN (statusline tee would be installed)\n' "$STATUSLINE_BIN"
    return 0
  fi
  mkdir -p "$AIB_HOME/bin" "$AIB_HOME/quota"
  chmod 700 "$AIB_HOME" "$AIB_HOME/bin" "$AIB_HOME/quota" 2>/dev/null || true
  if [ -f "$STATUSLINE_BIN" ] && cmp -s "$AIB_STATUSLINE_SRC" "$STATUSLINE_BIN"; then
    printf 'hooks\t-\t%s\tUNCHANGED (statusline tee)\n' "$STATUSLINE_BIN"
  else
    cp "$AIB_STATUSLINE_SRC" "$STATUSLINE_BIN"
    chmod 755 "$STATUSLINE_BIN"
    printf 'hooks\t-\t%s\tINSTALLED (statusline tee)\n' "$STATUSLINE_BIN"
  fi
}

# ---- per-account install -------------------------------------------------------

FAILED=0

install_account() { # $1 = label, $2 = dir
  local label="$1" dir="$2"
  local settings state_file passthrough quota_file hooks_url statusline_cmd
  local fragment existing merged original_sl had_original state_json

  settings="$dir/settings.json"
  state_file="$dir/$AIB_HOOKS_STATE_NAME"
  passthrough="$dir/$AIB_PASSTHROUGH_NAME"
  quota_file="$AIB_HOME/quota/$label.json"
  hooks_url="$(aib_hooks_url "$HOOKS_PORT" "$label")"
  aib_no_squote "account dir" "$dir"
  statusline_cmd="'$STATUSLINE_BIN' --label '$label' --quota-file '$quota_file' --passthrough '$passthrough'"

  if ! aib_marker_check "$label" "$dir"; then
    printf 'hooks\t%s\t%s\tREFUSED (see stderr)\n' "$label" "$dir"
    FAILED=1
    return 0
  fi

  existing="{}"
  if [ -f "$settings" ]; then
    if ! existing="$(jq -e 'if type == "object" then . else error("not an object") end' "$settings" 2>/dev/null)"; then
      printf 'hooks\t%s\t%s\tREFUSED (settings.json is not a JSON object — fix or move it; nothing touched)\n' "$label" "$dir"
      FAILED=1
      return 0
    fi
  fi

  fragment="$(aib_render_fragment "$label" "$hooks_url" "$OTLP_ENDPOINT" "$statusline_cmd")"

  # Pre-existing statusline (not ours) → capture for passthrough + restore.
  original_sl="$(printf '%s' "$existing" | jq -c '.statusLine // null')"
  had_original=0
  if [ "$original_sl" != "null" ]; then
    if printf '%s' "$original_sl" | jq -e '(.command // "") | contains("aibender-statusline.sh")' >/dev/null; then
      # already ours — keep whatever original the FIRST install recorded
      if [ -f "$state_file" ]; then
        original_sl="$(jq -c '.originalStatusLine // null' "$state_file" 2>/dev/null || printf 'null')"
      else
        original_sl="null"
      fi
    else
      had_original=1
    fi
  fi

  merged="$(printf '%s' "$existing" | jq -S --argjson ours "$fragment" "
    $AIB_JQ_PRELUDE
    . as \$base
    | .env = ((.env // {}) + \$ours.env)
    | .statusLine = \$ours.statusLine
    | .hooks = (
        (.hooks // {}) as \$h
        | \$h + (\$ours.hooks | with_entries(
            .value = (((\$h[.key] // []) | map(select(aib_is_hook_entry | not))) + .value)
          ))
      )
  ")"

  state_json="$(jq -nS \
    --arg label "$label" \
    --arg hooksUrl "$hooks_url" \
    --arg otlp "$OTLP_ENDPOINT" \
    --argjson env "$(aib_env_json "$label" "$OTLP_ENDPOINT")" \
    --argjson ours "$(printf '%s' "$fragment" | jq -c '.statusLine')" \
    --argjson orig "$original_sl" \
    --argjson x4 "$(aib_x4_state_json "$fragment")" \
    --arg pt "$passthrough" \
    '{schemaVersion: 1, label: $label, hooksUrl: $hooksUrl, otlpEndpoint: $otlp,
      env: $env, statusLine: $ours, originalStatusLine: $orig, x4: $x4,
      passthroughFile: (if $orig != null and ($orig.type? == "command") then $pt else null end)}')"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'hooks\t%s\t%s\tDRY-RUN (would merge %s hook events; statusline tee; OTel env)\n' \
      "$label" "$dir" "$(printf '%s' "$fragment" | jq '.hooks | length')"
    return 0
  fi

  # Passthrough snippet for a captured user statusline (command type only).
  if [ "$had_original" -eq 1 ]; then
    if printf '%s' "$original_sl" | jq -e '.type? == "command" and ((.command // "") != "")' >/dev/null; then
      {
        printf '#!/usr/bin/env bash\n'
        printf '# aibender-passthrough — the pre-install statusline command, preserved by\n'
        printf '# infra/hooks/install-hook-settings.sh. Removed on uninstall.\n'
        printf 'exec %s\n' "$(printf '%s' "$original_sl" | jq -r '.command')"
      } | aib_write_600 "$passthrough"
      chmod 700 "$passthrough"
    fi
  fi

  local before=""
  [ -f "$settings" ] && before="$(cat "$settings")"
  if [ "$merged" = "$before" ]; then
    printf 'hooks\t%s\t%s\tUNCHANGED\n' "$label" "$dir"
  else
    printf '%s\n' "$merged" | aib_write_600 "$settings" \
      || { printf 'hooks\t%s\t%s\tREFUSED (write failed)\n' "$label" "$dir"; FAILED=1; return 0; }
    printf 'hooks\t%s\t%s\tINSTALLED\n' "$label" "$dir"
  fi

  printf '%s\n' "$state_json" | aib_write_600 "$state_file"
  return 0
}

install_statusline_bin

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
  install_account "$label" "$dir"
done <<EOF_MANIFESTS
$(aib_profile_files "$PROFILES_DIR")
EOF_MANIFESTS

[ "$FOUND" -eq 1 ] || aib_die "no profile matched${ONLY_LABEL:+ label $ONLY_LABEL} in $PROFILES_DIR"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0
