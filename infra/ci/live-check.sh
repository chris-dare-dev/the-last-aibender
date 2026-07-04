#!/usr/bin/env bash
# live-check.sh — the SI-6 T3 live-host check runner (plan §6/SI-6, §9.1 T3).
#
# Hosted CI can never see the real Mac: the login keychain, Aqua launchd,
# the real `claude` binary, LM Studio, a real `opencode serve`. This script
# is the scripted LOCAL suite that enumerates every live-host check by
# milestone and reports, per check:
#
#   PASS — executed against the live host and succeeded
#   FAIL — executed and found a real problem (process exit code goes 1)
#   SKIP — pending-owner: prerequisite not enabled yet; the detail column
#          carries the exact runbook/doc that unblocks it
#
# It is runnable TODAY on any machine: everything not yet enabled reports
# SKIP with its runbook pointer instead of failing.
#
# Usage:
#   live-check.sh [--milestone M1|M2|M3|M6] [--check ID] [--list]
#                 [--allow-real-accounts] [--aibender-home DIR]
#
#   --list                 print the check registry and exit
#   --milestone Mx         run only that milestone's checks
#   --check ID             run a single check by id
#   --allow-real-accounts  enable checks that execute the real `claude`
#                          binary against real credential stores (read-only
#                          value access; never /login, never inference)
#   --aibender-home DIR    harness home override (default: $AIBENDER_HOME
#                          or ~/.aibender)
#
# Environment:
#   AIBENDER_HOME                 harness home (see --aibender-home)
#   AIBENDER_LIVECHECK_OFFLINE=1  force network/spawn checks (LM Studio,
#                                 opencode serve) to SKIP — used by the bats
#                                 suite; also useful offline
#   AIBENDER_LMSTUDIO_PORT        LM Studio port (default 1234)
#   AIBENDER_OPENCODE_TIMEOUT     seconds to wait for `opencode serve`
#                                 health (default 15)
#
# Report lines (tab-separated): check<TAB>ID<TAB>MILESTONE<TAB>STATUS<TAB>DETAIL
# Summary line: "RESULT: PASS|FAIL (P pass, F fail, S skip)"
# Exit codes: 0 = no FAIL · 1 = any FAIL · 2 = usage error.
#
# Hard rules honored here ([X2] + External System Write Policy):
#   * keychain access is PRESENCE-only via keychain-probe.sh — never `-w`
#   * never `claude /login`/logout; auth value access is opt-in
#     (--allow-real-accounts) and read-only (`claude auth status`)
#   * opencode serve: health/list/event endpoints ONLY — never message,
#     prompt, or inference calls; the temporary server is killed on exit
#   * LM Studio is probed, never started; down is a first-class state and
#     reports SKIP, never FAIL
#   * nothing here mutates launchd, the keychain, ~/.claude, or AWS

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACCOUNTS_DIR="$ROOT/infra/scripts/accounts"

# Registry: id|milestone|description|runbook-or-doc-pointer
# (Keep ids stable — the bats suite and milestone-gate docs reference them.)
CHECKS=(
  "keychain-probe|M1|per-account keychain item presence (never -w)|docs/runbooks/login-bootstrap.md"
  "version-gate|M1|service-name recompute vs certified baseline|docs/runbooks/version-gate.md"
  "auth-status|M1|per-account claude auth status --json value-access proof|docs/runbooks/login-bootstrap.md §4"
  "x1-live-demo|M1|one broker, three concurrent live sessions, zero re-login|docs/runbooks/kernel-live-spawn.md §'M1 acceptance run'"
  "sigkill-orphan|M1|real-child SIGKILL orphan/resume probe (spike vii re-run)|docs/runbooks/kernel-live-spawn.md"
  "aqua-launchd|M2|SI-3 rendered LaunchAgent plists lint + Aqua gui-domain state|docs/runbooks/launchd.md (SI-3) · plan §6/SI-3"
  "hooks-installed|M2|SI-3 hook settings installed into per-account config dirs (read-only)|docs/runbooks/hooks-telemetry.md"
  "lmstudio-probe|M2|LM Studio reachable on 127.0.0.1 (host-native [X3])|docs/research/summaries/01-architecture-blueprint.md §9"
  "opencode-serve-probe|M2|temporary opencode serve: health/list/event only|docs/research/findings/opencode-serve-event-probe.md"
  "aws-sso-plan|M3|SI-4 terraform plan (owner-run; apply hard-gated)|docs/runbooks/bedrock-iac.md"
  "signing-dryrun|M6|signed (dry-run) sidecar artifact cold-start|docs/spikes/spike-e-signing-ant.md"
)
MILESTONES="M1 M2 M3 M6"

usage() {
  sed -n '2,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'live-check: %s\n' "$*" >&2
  exit 2
}

info() {
  printf 'live-check: %s\n' "$*" >&2
}

LIST=0
ONLY_MILESTONE=""
ONLY_CHECK=""
ALLOW_REAL_ACCOUNTS=0
HOME_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1 ;;
    --milestone) shift; ONLY_MILESTONE="${1:?--milestone needs a value}" ;;
    --check) shift; ONLY_CHECK="${1:?--check needs a value}" ;;
    --allow-real-accounts) ALLOW_REAL_ACCOUNTS=1 ;;
    --aibender-home) shift; HOME_OVERRIDE="${1:?--aibender-home needs a value}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

if [ -n "$ONLY_MILESTONE" ]; then
  case " $MILESTONES " in
    *" $ONLY_MILESTONE "*) : ;;
    *) die "unknown milestone: $ONLY_MILESTONE (known: $MILESTONES)" ;;
  esac
fi

if [ -n "$ONLY_CHECK" ]; then
  found=0
  for row in "${CHECKS[@]}"; do
    [ "${row%%|*}" = "$ONLY_CHECK" ] && found=1
  done
  [ "$found" -eq 1 ] || die "unknown check: $ONLY_CHECK (try --list)"
fi

if [ "$LIST" -eq 1 ]; then
  for row in "${CHECKS[@]}"; do
    IFS='|' read -r id ms desc runbook <<<"$row"
    printf '%s\t%s\t%s\t%s\n' "$id" "$ms" "$desc" "$runbook"
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

aib_home() {
  if [ -n "$HOME_OVERRIDE" ]; then
    printf '%s\n' "$HOME_OVERRIDE"
  elif [ -n "${AIBENDER_HOME:-}" ]; then
    printf '%s\n' "$AIBENDER_HOME"
  else
    printf '%s\n' "$HOME/.aibender"
  fi
}

is_darwin() {
  [ "$(uname -s)" = "Darwin" ]
}

is_offline() {
  [ "${AIBENDER_LIVECHECK_OFFLINE:-0}" = "1" ]
}

# At least one provisioned account dir (SI-2 marker present)?
ACCOUNT_LABELS="max-a max-b ent"
provisioned_labels() {
  local home label out=""
  home="$(aib_home)"
  for label in $ACCOUNT_LABELS; do
    if [ -f "$home/accounts/$label/.aibender-account.json" ]; then
      out="$out $label"
    fi
  done
  printf '%s\n' "${out# }"
}

# ---------------------------------------------------------------------------
# Checks. Each function prints exactly one line: STATUS<TAB>DETAIL
# (diagnostics go to stderr). SKIP details always carry the unblock pointer.
# ---------------------------------------------------------------------------

check_keychain_probe() {
  local labels
  if ! is_darwin; then
    printf 'SKIP\tpending-owner: macOS-only (real login keychain) — run on the live host; see docs/runbooks/login-bootstrap.md\n'; return
  fi
  labels="$(provisioned_labels)"
  if [ -z "$labels" ]; then
    printf 'SKIP\tpending-owner: no provisioned account dirs under %s/accounts — see docs/runbooks/login-bootstrap.md §2–3\n' "$(aib_home)"; return
  fi
  if "$ACCOUNTS_DIR/keychain-probe.sh" --aibender-home "$(aib_home)" >&2; then
    printf 'PASS\tall per-account keychain items PRESENT (presence-only, never -w; labels:%s)\n' " $labels"
  else
    printf 'FAIL\tprobe reported MISSING/DRIFT — docs/runbooks/login-bootstrap.md §5 / version-gate.md BLOCK path\n'
  fi
}

check_version_gate() {
  local home
  home="$(aib_home)"
  if ! is_darwin; then
    printf 'SKIP\tpending-owner: macOS-only (keychain probe leg) — see docs/runbooks/version-gate.md\n'; return
  fi
  if [ -z "$(provisioned_labels)" ]; then
    printf 'SKIP\tpending-owner: accounts not provisioned — see docs/runbooks/login-bootstrap.md §2–3\n'; return
  fi
  if [ ! -f "$home/state/version-gate.json" ]; then
    printf 'SKIP\tpending-owner: no certified baseline — run version-gate.sh --init after certifying the pin; docs/runbooks/version-gate.md §0\n'; return
  fi
  if "$ACCOUNTS_DIR/version-gate.sh" --aibender-home "$home" >&2; then
    printf 'PASS\tgate PASS against certified baseline (presence-only probe leg included)\n'
  else
    printf 'FAIL\tgate BLOCK — do not bump/launch; docs/runbooks/version-gate.md §3\n'
  fi
}

check_auth_status() {
  local home labels label ok=0 total=0 failed=""
  home="$(aib_home)"
  if ! is_darwin; then
    printf 'SKIP\tpending-owner: macOS-only (T3) — see docs/runbooks/login-bootstrap.md §4\n'; return
  fi
  if ! command -v claude >/dev/null 2>&1; then
    printf 'SKIP\tpending-owner: claude CLI not on PATH — see docs/runbooks/login-bootstrap.md\n'; return
  fi
  labels="$(provisioned_labels)"
  if [ -z "$labels" ]; then
    printf 'SKIP\tpending-owner: accounts not provisioned — see docs/runbooks/login-bootstrap.md §2–3\n'; return
  fi
  if [ "$ALLOW_REAL_ACCOUNTS" -ne 1 ]; then
    printf 'SKIP\tpending-owner: value-access proof runs the real claude binary — re-run with --allow-real-accounts (owner only); docs/runbooks/login-bootstrap.md §4\n'; return
  fi
  command -v jq >/dev/null 2>&1 || { printf 'SKIP\tpending-owner: jq required to validate auth output (brew install jq) — docs/runbooks/login-bootstrap.md §4\n'; return; }
  for label in $labels; do
    total=$((total + 1))
    # Read-only value-access proof. Output is NEVER printed — it can carry
    # org identity [X2]; we only test that it parses as JSON.
    if CLAUDE_CONFIG_DIR="$home/accounts/$label" \
       CLAUDE_SECURESTORAGE_CONFIG_DIR="$home/accounts/$label" \
       claude auth status --json 2>/dev/null | jq -e . >/dev/null 2>&1; then
      ok=$((ok + 1))
    else
      failed="$failed $label"
    fi
  done
  if [ "$ok" -eq "$total" ]; then
    printf 'PASS\t%s/%s accounts return parseable auth status (values not printed [X2])\n' "$ok" "$total"
  else
    printf 'FAIL\taccounts failing value access:%s — docs/runbooks/login-bootstrap.md §5 troubleshooting\n' "$failed"
  fi
}

check_x1_live_demo() {
  printf 'SKIP\tpending-owner: manual, costs real usage — one broker, three concurrent live sessions; docs/runbooks/kernel-live-spawn.md §"M1 acceptance run"\n'
}

check_sigkill_orphan() {
  printf 'SKIP\tpending-owner: manual — real-child SIGKILL orphan/resume re-run rides the live spawn path; docs/runbooks/kernel-live-spawn.md (synthetic edition is covered by core unit tests)\n'
}

check_aqua_launchd() {
  local templates plists plist label loaded=0 count=0
  templates="$(find "$ROOT/infra/launchd/templates" -name '*.plist.template' -type f 2>/dev/null || true)"
  if [ -z "$templates" ]; then
    printf 'SKIP\tpending-owner: SI-3 LaunchAgent templates not landed in infra/launchd/templates/ — plan §6/SI-3\n'; return
  fi
  # Templates are rendered with machine-local values into $AIBENDER_HOME/launchd
  # by infra/launchd/render-launchd.sh (which never runs launchctl); this check
  # validates the RENDERED output and reads the Aqua gui-domain state.
  plists="$(find "$(aib_home)/launchd" -name '*.plist' -type f 2>/dev/null || true)"
  if [ -z "$plists" ]; then
    printf 'SKIP\tpending-owner: templates landed but not rendered — run infra/launchd/render-launchd.sh, then install per docs/runbooks/launchd.md (SI-3, owner-run)\n'; return
  fi
  if ! is_darwin; then
    printf 'SKIP\tpending-owner: plutil lint + Aqua gui-domain check are macOS-only (T3) — docs/runbooks/launchd.md\n'; return
  fi
  while IFS= read -r plist; do
    count=$((count + 1))
    if ! plutil -lint "$plist" >&2; then
      printf 'FAIL\tplist fails plutil -lint: %s\n' "${plist#"$ROOT"/}"
      return
    fi
    # -o - is load-bearing: without it plutil -extract REWRITES the plist.
    label="$(plutil -extract Label raw -o - "$plist" 2>/dev/null || true)"
    if [ -n "$label" ] && launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      loaded=$((loaded + 1))
    fi
  done <<<"$plists"
  if [ "$loaded" -gt 0 ]; then
    printf 'PASS\t%s plist(s) lint clean; %s label(s) loaded in the Aqua gui domain\n' "$count" "$loaded"
  else
    printf 'PASS\t%s plist(s) lint clean; none loaded — the LaunchAgent flip is deliberately deferred (plan §8.2 M6)\n' "$count"
  fi
}

# SI-3 installs hooks into the PER-ACCOUNT config dirs
# ($AIBENDER_HOME/accounts/<label>/settings.json, provenance-marker guarded)
# and never touches ~/.claude — so this check inspects those dirs, read-only.
# An account counts as installed when its settings.json carries an
# aibender-owned hook entry: type:"http" POSTing to a loopback /hooks/v1/ URL
# (docs/contracts/hooks-contract.md §1; same ownership predicate as the
# installer's AIB_JQ_PRELUDE). Without jq we fall back to the installer's
# .aibender-hooks.json state file.
check_hooks_installed() {
  local home labels label dir settings state installed missing="" total=0 ok=0
  if [ ! -f "$ROOT/infra/hooks/templates/settings.fragment.json.template" ]; then
    printf 'SKIP\tpending-owner: SI-3 hook settings template not landed in infra/hooks/templates/ — shape governed by docs/contracts/hooks-contract.md\n'; return
  fi
  home="$(aib_home)"
  labels="$(provisioned_labels)"
  if [ -z "$labels" ]; then
    printf 'SKIP\tpending-owner: no provisioned account dirs under %s/accounts — provision (SI-2), then install hooks per docs/runbooks/hooks-telemetry.md\n' "$home"; return
  fi
  for label in $labels; do
    total=$((total + 1))
    dir="$home/accounts/$label"
    settings="$dir/settings.json"
    state="$dir/.aibender-hooks.json"
    installed=0
    if command -v jq >/dev/null 2>&1; then
      if [ -f "$settings" ] && jq -e '
            [ .hooks? // {} | objects | .[] | arrays | .[] | objects
              | .hooks? // [] | arrays | .[] | objects
              | select(.type == "http"
                       and ((.url // "") | test("^http://127\\.0\\.0\\.1:[0-9]+/hooks/v1/"))) ]
            | length > 0' "$settings" >/dev/null 2>&1; then
        installed=1
      fi
    elif [ -f "$state" ]; then
      # no jq on this host: the installer's state file is the install proof
      installed=1
    fi
    if [ "$installed" -eq 1 ]; then
      ok=$((ok + 1))
    else
      missing="$missing $label"
    fi
  done
  if [ "$ok" -eq "$total" ]; then
    printf 'PASS\t%s/%s provisioned accounts carry aibender /hooks/v1/ hook entries in their per-account settings.json (read-only check; labels:%s)\n' "$ok" "$total" " $labels"
  else
    printf 'SKIP\tpending-owner: hooks not installed for account(s):%s — run infra/hooks/install-hook-settings.sh (owner, T3); docs/runbooks/hooks-telemetry.md\n' "$missing"
  fi
}

check_lmstudio_probe() {
  local port
  if is_offline; then
    printf 'SKIP\tpending-owner: offline mode (AIBENDER_LIVECHECK_OFFLINE=1) — re-run on the live host; docs/research/summaries/01-architecture-blueprint.md §9\n'; return
  fi
  command -v curl >/dev/null 2>&1 || { printf 'SKIP\tpending-owner: curl not available on this host — docs/research/summaries/01-architecture-blueprint.md §9\n'; return; }
  port="${AIBENDER_LMSTUDIO_PORT:-1234}"
  if curl -fsS --max-time 3 "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1; then
    printf 'PASS\tLM Studio reachable on 127.0.0.1:%s (host-native path [X3])\n' "$port"
  else
    printf 'SKIP\tpending-owner: LM Studio down on 127.0.0.1:%s — down is a first-class state and it is NEVER auto-started; start it manually to certify reachability (docs/research/summaries/01-architecture-blueprint.md §9 [X3])\n' "$port"
  fi
}

check_opencode_serve_probe() {
  local port pid tmpdir deadline waited=0 version health sessions events rc=0
  if is_offline; then
    printf 'SKIP\tpending-owner: offline mode (AIBENDER_LIVECHECK_OFFLINE=1) — re-run on the live host; docs/research/findings/opencode-serve-event-probe.md\n'; return
  fi
  if ! command -v opencode >/dev/null 2>&1; then
    printf 'SKIP\tpending-owner: opencode binary not on PATH — docs/research/findings/opencode-serve-event-probe.md\n'; return
  fi
  command -v curl >/dev/null 2>&1 || { printf 'SKIP\tpending-owner: curl not available on this host — docs/research/findings/opencode-serve-event-probe.md\n'; return; }
  command -v jq >/dev/null 2>&1 || { printf 'SKIP\tpending-owner: jq required (brew install jq) — docs/research/findings/opencode-serve-event-probe.md\n'; return; }

  port=$((20000 + RANDOM % 10000))
  deadline="${AIBENDER_OPENCODE_TIMEOUT:-15}"
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/aibender-livecheck.XXXXXX")"

  # This function runs in a command-substitution subshell (see main loop), so
  # cd-ing here never leaks; serving from an empty tmpdir keeps the probe off
  # the real repo tree.
  cd "$tmpdir" || { printf 'SKIP\tpending-owner: could not enter probe tmpdir — docs/research/findings/opencode-serve-event-probe.md\n'; return; }

  # Read-only probe server: health/list/event ONLY — never message/prompt/
  # inference endpoints (they cost money and mutate sessions). Spawned
  # directly (no wrapper subshell) so $! is the server pid we later kill.
  opencode serve --hostname 127.0.0.1 --port "$port" >"$tmpdir/serve.log" 2>&1 &
  pid=$!
  # shellcheck disable=SC2064  # expand pid/tmpdir now, on purpose
  trap "kill -TERM $pid 2>/dev/null || true; sleep 1; kill -KILL $pid 2>/dev/null || true; pkill -P $pid 2>/dev/null || true; cd /; rm -rf '$tmpdir'" RETURN

  health=""
  while [ "$waited" -lt "$deadline" ]; do
    if health="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/global/health" 2>/dev/null)" \
       && printf '%s' "$health" | jq -e '.healthy == true' >/dev/null 2>&1; then
      break
    fi
    health=""
    sleep 1
    waited=$((waited + 1))
  done
  if [ -z "$health" ]; then
    printf 'FAIL\topencode serve did not report healthy within %ss on 127.0.0.1:%s — docs/research/findings/opencode-serve-event-probe.md\n' "$deadline" "$port"
    return
  fi
  version="$(printf '%s' "$health" | jq -r '.version // "unknown"')"

  # list: GET /session must return a JSON array (read-only).
  sessions="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/session" 2>/dev/null)" || rc=1
  if [ "$rc" -ne 0 ] || ! printf '%s' "$sessions" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf 'FAIL\tGET /session did not return a JSON array (serve v%s)\n' "$version"
    return
  fi

  # event: the SSE stream opens with a server.connected event; read a short
  # window then let curl time out (exit 28 is expected on an open stream).
  events="$(curl -sN --max-time 3 "http://127.0.0.1:$port/event" 2>/dev/null | head -c 4096 || true)"
  if ! printf '%s' "$events" | grep -q 'server.connected'; then
    printf 'FAIL\tGET /event opened but no server.connected within the read window (serve v%s)\n' "$version"
    return
  fi

  printf 'PASS\topencode serve v%s: /global/health, /session, /event OK on 127.0.0.1:%s (read-only; temp server killed)\n' "$version" "$port"
}

# SI-4 edit (coordinate with SI-6): detail strings only — the check stays a
# SKIP by design. Plan needs live SSO credentials (owner-run) and APPLY is
# hard-gated on the owner's explicit verbal OK; neither ever runs from here.
check_aws_sso_plan() {
  local tf
  tf="$(find "$ROOT/infra/aws" -name '*.tf' -type f 2>/dev/null || true)"
  if [ -z "$tf" ]; then
    printf 'SKIP\tpending-owner: SI-4 IaC not landed in infra/aws/ — docs/runbooks/bedrock-iac.md · plan §6/SI-4 (gated)\n'; return
  fi
  printf 'SKIP\tpending-owner: SI-4 IaC landed (validate/bats green) — owner-run sequence: aws sso login, terraform plan, review, verbal OK; APPLY is hard-gated (External System Write Policy) and never run from this script; until applied BE-5 is estimate-only — docs/runbooks/bedrock-iac.md\n'
}

check_signing_dryrun() {
  printf 'SKIP\tpending-owner: packaging lands at M6 — signing dry-run automation follows docs/spikes/spike-e-signing-ant.md; wire the built .app cold-start here when BE-9/packaging exists\n'
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

info "host=$(uname -s) home=$(aib_home) offline=${AIBENDER_LIVECHECK_OFFLINE:-0} allow-real-accounts=$ALLOW_REAL_ACCOUNTS"

pass=0 failcnt=0 skip=0 ran=0
for row in "${CHECKS[@]}"; do
  IFS='|' read -r id ms _ <<<"$row"
  [ -n "$ONLY_MILESTONE" ] && [ "$ms" != "$ONLY_MILESTONE" ] && continue
  [ -n "$ONLY_CHECK" ] && [ "$id" != "$ONLY_CHECK" ] && continue
  ran=$((ran + 1))

  fn="check_$(printf '%s' "$id" | tr '-' '_')"
  line="$("$fn")"
  status="${line%%$'\t'*}"
  detail="${line#*$'\t'}"
  case "$status" in
    PASS) pass=$((pass + 1)) ;;
    FAIL) failcnt=$((failcnt + 1)) ;;
    SKIP) skip=$((skip + 1)) ;;
    *) die "check $id returned malformed status: $status" ;;
  esac
  printf 'check\t%s\t%s\t%s\t%s\n' "$id" "$ms" "$status" "$detail"
done

[ "$ran" -gt 0 ] || die "no checks selected"

if [ "$failcnt" -gt 0 ]; then
  printf 'RESULT: FAIL (%s pass, %s fail, %s skip)\n' "$pass" "$failcnt" "$skip"
  exit 1
fi
printf 'RESULT: PASS (%s pass, %s fail, %s skip)\n' "$pass" "$failcnt" "$skip"
