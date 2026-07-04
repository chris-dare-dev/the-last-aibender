#!/usr/bin/env bash
# version-gate.sh — the mandatory pre-SDK-bump gate ([X1] rule 4, SI-2).
#
# The keychain service-name derivation is UNDOCUMENTED upstream; any Claude
# Code / SDK bump may silently change it and "log out" every account (the CLI
# would look at different, empty keychain slots). This gate:
#
#   1. recomputes the expected service name per account manifest,
#   2. diffs against the last-certified baseline (state file under
#      $AIBENDER_HOME/state/), and
#   3. runs keychain-probe.sh (presence, never -w),
#
# then prints RESULT: PASS or RESULT: BLOCK. A PASS here is NOT a full
# certification — the T3 owner-run steps (per-account `claude auth status
# --json`, and the setup-token keychain-DELETION canary before rung 2 is ever
# enabled) are documented in docs/runbooks/version-gate.md and are NEVER
# executed headlessly by this script.
#
# Usage:
#   version-gate.sh [--dry-run] [--init] [--aibender-home DIR]
#                   [--profiles-dir DIR] [--service-base NAME] [--state-file F]
#
#   --init     write the baseline state file from the current recompute
#              (run it only after certifying the current pinned version)
#   --dry-run  no keychain probe, no state writes; diff logic still runs
#
# Report lines (tab-separated): gate<TAB>LABEL<TAB>SERVICE<TAB>MATCH|MISMATCH
# Exit codes: 0 = PASS (or --init ok) · 1 = BLOCK or error.
#
# Sources: blueprint §3 rule 4, plan §6/SI-2 + §10 (risk row "keychain scoping
# changes in an SDK bump"), x1-parallel-multi-account findings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/accounts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

DRY_RUN=0
INIT=0
HOME_OVERRIDE=""
PROFILES_DIR=""
STATE_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --init) INIT=1 ;;
    --aibender-home) shift; HOME_OVERRIDE="${1:?--aibender-home needs a value}" ;;
    --profiles-dir) shift; PROFILES_DIR="${1:?--profiles-dir needs a value}" ;;
    --service-base) shift; AIBENDER_KEYCHAIN_SERVICE_BASE="${1:?--service-base needs a value}"; export AIBENDER_KEYCHAIN_SERVICE_BASE ;;
    --state-file) shift; STATE_FILE="${1:?--state-file needs a value}" ;;
    -h|--help) usage; exit 0 ;;
    *) aib_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

aib_require_cmds jq
AIB_HOME="$(aib_home_resolve "$HOME_OVERRIDE")"
[ -n "$PROFILES_DIR" ] || PROFILES_DIR="$(aib_default_profiles_dir "$SCRIPT_DIR")"
[ -n "$STATE_FILE" ] || STATE_FILE="$AIB_HOME/state/version-gate.json"
service_base="${AIBENDER_KEYCHAIN_SERVICE_BASE:-$AIB_DEFAULT_SERVICE_BASE}"

# ---- recompute expected service names from the manifests --------------------
labels=()
dirs=()
svcs=()

manifests="$(aib_profile_files "$PROFILES_DIR")"
[ -n "$manifests" ] || aib_die "no *.profile.json manifests found in $PROFILES_DIR"

while IFS= read -r f; do
  resolved="$(aib_profile_resolve "$f" "$AIB_HOME")"
  labels+=("${resolved%%$'\t'*}")
  dirs+=("${resolved#*$'\t'}")
  svcs+=("$(aib_service_name "${resolved#*$'\t'}")")
done <<EOF_MANIFESTS
$manifests
EOF_MANIFESTS

# ---- --init: write (or preview) the baseline --------------------------------
if [ "$INIT" -eq 1 ]; then
  accounts_json="[]"
  i=0
  while [ "$i" -lt "${#labels[@]}" ]; do
    accounts_json="$(jq -n \
      --argjson acc "$accounts_json" \
      --arg l "${labels[$i]}" --arg d "${dirs[$i]}" --arg s "${svcs[$i]}" \
      '$acc + [{label: $l, dir: $d, service: $s}]')"
    i=$((i + 1))
  done
  # Best-effort record of the CLI version being certified (read-only; override
  # the binary with AIBENDER_CLAUDE_BIN for hermetic tests).
  claude_version="$("${AIBENDER_CLAUDE_BIN:-claude}" --version 2>/dev/null | head -n 1 || true)"
  [ -n "$claude_version" ] || claude_version="unknown"
  state_json="$(jq -n \
    --arg at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg base "$service_base" \
    --arg cv "$claude_version" \
    --argjson accounts "$accounts_json" \
    '{schemaVersion: 1, baselineAt: $at, serviceBase: $base,
      claudeVersion: $cv, accounts: $accounts}')"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "# DRY-RUN: would write baseline to $STATE_FILE:"
    printf '%s\n' "$state_json"
  else
    umask 077
    mkdir -p "$(dirname "$STATE_FILE")"
    printf '%s\n' "$state_json" > "$STATE_FILE"
    chmod 600 "$STATE_FILE"
    echo "gate: baseline written to $STATE_FILE (certify only AFTER a green probe + the T3 steps in docs/runbooks/version-gate.md)"
  fi
  exit 0
fi

# ---- gate: baseline diff -----------------------------------------------------
block=0
reasons=""

add_reason() {
  reasons="${reasons}#   - $1
"
  block=1
}

if [ ! -f "$STATE_FILE" ]; then
  echo "gate: no baseline state file at $STATE_FILE"
  echo "#   Run 'version-gate.sh --init' on the currently-certified SDK first."
  echo "RESULT: BLOCK"
  exit 1
fi

baseline_base="$(jq -r '.serviceBase // empty' "$STATE_FILE")"
baseline_version="$(jq -r '.claudeVersion // "unknown"' "$STATE_FILE")"
if [ "$baseline_base" != "$service_base" ]; then
  add_reason "service base drifted: baseline '$baseline_base' vs current '$service_base'"
fi

i=0
while [ "$i" -lt "${#labels[@]}" ]; do
  l="${labels[$i]}"
  s="${svcs[$i]}"
  bl="$(jq -r --arg l "$l" '.accounts[] | select(.label == $l) | .service' "$STATE_FILE")"
  if [ -z "$bl" ]; then
    printf 'gate\t%s\t%s\tMISMATCH\n' "$l" "$s"
    add_reason "$l is absent from the baseline"
  elif [ "$bl" = "$s" ]; then
    printf 'gate\t%s\t%s\tMATCH\n' "$l" "$s"
  else
    printf 'gate\t%s\t%s\tMISMATCH\n' "$l" "$s"
    add_reason "$l expected service drifted: baseline '$bl' vs recomputed '$s'"
  fi
  i=$((i + 1))
done

# ---- gate: keychain presence probe -------------------------------------------
probe_args=("--aibender-home" "$AIB_HOME" "--profiles-dir" "$PROFILES_DIR")
[ "$DRY_RUN" -eq 1 ] && probe_args+=("--dry-run")
if ! "$SCRIPT_DIR/keychain-probe.sh" "${probe_args[@]}"; then
  add_reason "keychain probe reported MISSING/DRIFT items (see probe lines above)"
fi

# ---- verdict -----------------------------------------------------------------
echo "#"
echo "# baseline: $STATE_FILE (claudeVersion: $baseline_version)"
if [ "$block" -eq 1 ]; then
  echo "# BLOCK reasons:"
  printf '%s' "$reasons"
  echo "#   Hold the pinned SDK. If the derivation changed, consult the [X1]"
  echo "#   fallback ladder rung 2 and file an ADR (plan §10)."
  echo "RESULT: BLOCK"
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "# PASS is ADVISORY (dry-run: presence probe skipped — not a certification)."
fi
echo "# Reminder: PASS ≠ certified. T3 owner-run steps remain (never headless):"
echo "#   1. claude auth status --json per account   (login-bootstrap.md §4)"
echo "#   2. setup-token keychain-DELETION canary BEFORE enabling rung 2"
echo "#      (version-gate.md §5 — issue-#37512 class)"
echo "#   Then re-baseline: version-gate.sh --init"
echo "RESULT: PASS"
exit 0
