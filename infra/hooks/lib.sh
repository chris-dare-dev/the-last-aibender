# shellcheck shell=bash
# lib.sh — shared helpers for the SI-3 hook settings installer/uninstaller.
#
# SOURCED, never executed. Bash 3.2-compatible. Builds on the SI-2 accounts
# library (aib_die/aib_home_resolve/aib_profile_*): the profile manifests in
# infra/profiles/ are the single source of account labels and dirs.
#
# [X2]: everything rendered here carries placeholder labels only
# (MAX_<X>|ENT). The hook templates POST to 127.0.0.1 exclusively and
# register no command hooks (hooks-contract.md §5.3); the only shell command
# these settings ever reference is the statusline tee, which writes only
# under $AIBENDER_HOME.

_AIB_HOOKS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/accounts/lib.sh
. "$_AIB_HOOKS_LIB_DIR/../scripts/accounts/lib.sh"

# shellcheck disable=SC2034  # consumed by the sourcing scripts
AIB_HOOKS_TEMPLATE="$_AIB_HOOKS_LIB_DIR/templates/settings.fragment.json.template"
# shellcheck disable=SC2034
AIB_STATUSLINE_SRC="$_AIB_HOOKS_LIB_DIR/statusline/aibender-statusline.sh"
# shellcheck disable=SC2034
AIB_HOOKS_STATE_NAME=".aibender-hooks.json"
# shellcheck disable=SC2034
AIB_PASSTHROUGH_NAME=".aibender-statusline-passthrough.sh"
# shellcheck disable=SC2034
AIB_DEFAULT_HOOKS_PORT=4319   # hooks-contract.md §1 (AIBENDER_HOOKS_PORT)
# shellcheck disable=SC2034
AIB_DEFAULT_OTLP_PORT=4318    # blueprint §6.1 in-process OTLP receiver

# SEC-3/SI-3 per-install hook token (hooks-contract.md §4.2). The header name
# is the frozen protocol constant HOOK_TOKEN_HEADER — MUST stay in lockstep
# with core/src/collector/hooks/server.ts. The VALUE is a stable per-install
# secret (basename below, under $AIBENDER_HOME, 0600) minted once and shared
# with the broker: BE-MAIN READS it and passes it as startHooksServer's
# authToken. It is DISTINCT from the per-boot WS gateway token (which lives in
# the gateway bootstrap file). Injection is opt-in (install --hook-token) and
# OFF by default — the default install stays byte-identical to the pre-token
# (M2–M6 open) posture until the T3 pinned-CLI header-forwarding proof lands.
# shellcheck disable=SC2034
AIB_HOOK_TOKEN_HEADER='x-aibender-hook-token'
# shellcheck disable=SC2034
AIB_HOOK_TOKEN_NAME='hook-token'   # $AIBENDER_HOME/hook-token, 0600
# shellcheck disable=SC2034
AIB_HOOK_TOKEN_DRYRUN='dry-run-token-not-persisted'  # placeholder; never written

# jq prelude shared by install/uninstall: an entry is aibender-owned iff every
# hook in it is a type:"http" POST to a loopback /hooks/v1/ URL
# (hooks-contract.md §1). Everything else in settings.json is the user's.
# shellcheck disable=SC2034
AIB_JQ_PRELUDE='
def aib_is_hook_entry:
  ((.hooks // []) | length) > 0
  and ((.hooks // []) | all(
    .type == "http"
    and ((.url // "") | test("^http://127\\.0\\.0\\.1:[0-9]+/hooks/v1/"))
  ));
'

aib_port_validate() { # $1 = name, $2 = value
  case "$2" in
    ''|*[!0-9]*) aib_die "$1 must be an integer port (got: $2)" ;;
  esac
  [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || aib_die "$1 out of range 1-65535 (got: $2)"
}

aib_hooks_url() { # $1 = port, $2 = label
  printf 'http://127.0.0.1:%s/hooks/v1/%s' "$1" "$2"
}

aib_otlp_endpoint() { # $1 = port
  printf 'http://127.0.0.1:%s' "$1"
}

# Mint a per-install hook token: 32 random bytes → base64url, no padding (the
# same shape as the gateway boot token, core/src/gateway/token.ts:newBootToken
# → 43 chars). openssl preferred; /dev/urandom is the fallback. Value only —
# the caller persists it 0600 and never logs it.
aib_gen_token() {
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw="$(openssl rand -base64 32)"
  else
    raw="$(LC_ALL=C dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64)"
  fi
  printf '%s' "$raw" | tr -d '\n' | tr '+/' '-_' | tr -d '='
}

# Read a persisted hook token: first line, whitespace-stripped (tolerant of a
# trailing newline). Empty output = empty/absent file — the caller decides.
aib_read_hook_token() { # $1 = token file
  local tok=""
  [ -f "$1" ] || { printf ''; return 0; }
  IFS= read -r tok < "$1" || true
  # strip any surrounding whitespace without spawning a subshell per char
  printf '%s' "$tok" | tr -d '[:space:]'
}

# The hook-token activation record for the state file (hooks-contract.md §4.2).
# Records that injection is ON, the header name, and the token file path — but
# NEVER the token value (minimise secret copies; the 0600 file is the one home
# for it). Derived so the record cannot claim a header the install did not add.
aib_hook_token_state_json() { # $1 = header, $2 = token file
  jq -n --arg hdr "$1" --arg file "$2" \
    '{enabled: true, header: $hdr, tokenFile: $file,
      note: "per-install secret shared with the broker authToken; value lives only in the 0600 token file (hooks-contract.md §4.2)"}'
}

# The exact env block the fragment installs, as JSON, for one label.
# MUST stay in lockstep with templates/settings.fragment.json.template.
aib_env_json() { # $1 = label, $2 = otlp endpoint
  jq -n --arg label "$1" --arg otlp "$2" '{
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": $otlp,
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_RESOURCE_ATTRIBUTES": ("account=" + $label),
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID": "false"
  }'
}

# The [X4] automation activation record for the state file (hooks-contract.md
# §7.1, M4). Derived FROM the rendered fragment so the record and the
# installed settings can never drift. The three slots ride the same
# type:"http" envelope as every other event (contract §5.4); SessionStart is
# the ONE slot whose `200` response the CLI applies as hook output — the
# frozen brief-injection shape `hookSpecificOutput.additionalContext`
# (contract §7.1). The collector's default stays 204 (no injection) until the
# pinned-CLI interpretation of that body is verified on the real host (T3,
# docs/runbooks/hooks-telemetry.md) — activation here is template-side only.
aib_x4_state_json() { # $1 = rendered fragment JSON
  printf '%s' "$1" | jq -cS '{
    slots: ["SessionEnd", "PreCompact", "SessionStart"],
    sessionStart: {
      matcher: .hooks.SessionStart[0].matcher,
      timeoutSeconds: .hooks.SessionStart[0].hooks[0].timeout,
      responseApplied: "hookSpecificOutput.additionalContext (hooks-contract.md §7.1)"
    },
    injectionDefault:
      "204 until the pinned-CLI additionalContext interpretation is verified (T3 — docs/runbooks/hooks-telemetry.md)"
  }'
}

# Shell-quote guard: the statusline command string embeds paths in single
# quotes; a single quote inside them would truncate the command.
aib_no_squote() { # $1 = description, $2 = value
  case "$2" in
    *"'"*) aib_die "$1 must not contain a single quote: $2" ;;
  esac
}

# Render the settings fragment for one account. Exact-token replacement via
# jq (values are JSON-escaped correctly by construction), then — when a
# per-install hook token is configured ($5 non-empty) — the SEC-3/SI-3 header
# is stamped onto EVERY loopback /hooks/v1/ http hook so real POSTs carry the
# collector's authToken credential (hooks-contract.md §4.2). An empty $5 (the
# default) renders byte-identical to the pre-token install. Closes with a guard
# that no {{token}} survived.
aib_render_fragment() { # $1 label, $2 hooks_url, $3 otlp_endpoint, $4 statusline_cmd, $5 hook_token (empty = no header)
  jq -S \
    --arg label "$1" \
    --arg url "$2" \
    --arg otlp "$3" \
    --arg sl "$4" \
    --arg tok "$5" \
    --arg hdr "$AIB_HOOK_TOKEN_HEADER" '
    walk(
      if type == "string" then
        if . == "{{HOOKS_URL}}" then $url
        elif . == "{{OTLP_ENDPOINT}}" then $otlp
        elif . == "{{STATUSLINE_COMMAND}}" then $sl
        elif . == "account={{ACCOUNT_LABEL}}" then ("account=" + $label)
        else .
        end
      else .
      end
    )
    | (if ($tok | length) > 0 then
         walk(
           if (type == "object")
              and (.type? == "http")
              and (((.url? // "") | test("^http://127\\.0\\.0\\.1:[0-9]+/hooks/v1/")))
           then .headers = { ($hdr): $tok }
           else . end
         )
       else . end)
    | if ([.. | strings | select(test("\\{\\{"))] | length) > 0
      then error("unsubstituted token in rendered fragment")
      else . end
  ' "$AIB_HOOKS_TEMPLATE"
}

# Atomic 0600 write: tmp in the same dir + rename.
aib_write_600() { # $1 = target path; content on stdin
  local target="$1" tmp
  tmp="$target.$$.tmp"
  cat > "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
}

# Verify the SI-2 provenance marker before touching an account dir.
aib_marker_check() { # $1 = label, $2 = dir → 0 ok, prints reason on stderr otherwise
  local label="$1" dir="$2" marker got
  marker="$dir/$AIB_MARKER_NAME"
  if [ ! -d "$dir" ]; then
    printf 'account dir missing (run infra/scripts/accounts/provision-accounts.sh first): %s\n' "$dir" >&2
    return 1
  fi
  if [ ! -f "$marker" ]; then
    printf 'provenance marker missing (%s) — refusing to modify an unmanaged dir\n' "$marker" >&2
    return 1
  fi
  got="$(jq -er '.label' "$marker" 2>/dev/null)" || {
    printf 'provenance marker unreadable: %s\n' "$marker" >&2
    return 1
  }
  if [ "$got" != "$label" ]; then
    printf 'provenance marker label mismatch: expected %s, marker says %s\n' "$label" "$got" >&2
    return 1
  fi
  return 0
}
