#!/usr/bin/env bash
# keychain-probe.sh — per-account keychain PRESENCE report ([X1] self-check, SI-2).
#
# Recomputes the expected keychain service name for every account manifest
# (base + first 8 hex of sha256 of the NFC-normalized securestorage dir string)
# and probes item PRESENCE with `security find-generic-password` — NEVER with
# -w. Credential VALUES are never read, printed, or stored by this script [X2].
# Value access is proven separately, in the broker's own context, via
# `claude auth status --json` per account — a T3 owner-run step documented in
# docs/runbooks/login-bootstrap.md §4.
#
# Usage:
#   keychain-probe.sh [--dry-run] [--aibender-home DIR] [--profiles-dir DIR]
#                     [--service-base NAME]
#
# --dry-run computes and reports expected service names without touching the
# keychain (works headlessly on any OS). Real probes are macOS-only (T3).
#
# Report lines (tab-separated): probe<TAB>LABEL<TAB>SERVICE<TAB>STATUS
#   STATUS ∈ PRESENT | MISSING | DRIFT | DRY-RUN
# Exit codes: 0 = all PRESENT (or dry-run, no drift) · 1 = any MISSING/DRIFT.
#
# Sources: blueprint §3 rule 4, plan §6/SI-2, x1-parallel-multi-account findings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/accounts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

DRY_RUN=0
HOME_OVERRIDE=""
PROFILES_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --aibender-home) shift; HOME_OVERRIDE="${1:?--aibender-home needs a value}" ;;
    --profiles-dir) shift; PROFILES_DIR="${1:?--profiles-dir needs a value}" ;;
    --service-base) shift; AIBENDER_KEYCHAIN_SERVICE_BASE="${1:?--service-base needs a value}"; export AIBENDER_KEYCHAIN_SERVICE_BASE ;;
    -h|--help) usage; exit 0 ;;
    *) aib_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

aib_require_cmds jq
AIB_HOME="$(aib_home_resolve "$HOME_OVERRIDE")"
[ -n "$PROFILES_DIR" ] || PROFILES_DIR="$(aib_default_profiles_dir "$SCRIPT_DIR")"

if [ "$DRY_RUN" -eq 0 ]; then
  command -v security >/dev/null 2>&1 || aib_die "security(1) not found — real keychain probes are macOS-only (T3). Use --dry-run elsewhere."
fi

# The binary keys the item's account attribute off $USER (falls back to the
# posix username) — mirror that.
probe_user="${USER:-$(id -un)}"

rc=0
t3_block=""

manifests="$(aib_profile_files "$PROFILES_DIR")"
[ -n "$manifests" ] || aib_die "no *.profile.json manifests found in $PROFILES_DIR"

while IFS= read -r f; do
  resolved="$(aib_profile_resolve "$f" "$AIB_HOME")"
  label="${resolved%%$'\t'*}"
  dir="${resolved#*$'\t'}"
  svc="$(aib_service_name "$dir")"
  marker="$dir/$AIB_MARKER_NAME"
  status=""

  # Byte-stability drift check: the marker records the dir string used at
  # provision time; if today's recompute differs, the CLI would be looking at
  # a DIFFERENT keychain slot (the silent-"logged out" failure mode).
  if [ -f "$marker" ]; then
    mdir="$(jq -r '.dir // empty' "$marker" 2>/dev/null || true)"
    if [ -n "$mdir" ] && [ "$mdir" != "$dir" ]; then
      status="DRIFT"
      aib_warn "$label: dir string drifted — marker has '$mdir', recompute says '$dir'. Byte-stable paths are rule 2 (blueprint §3); do not launch until resolved."
      rc=1
    fi
  fi

  if [ -z "$status" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      status="DRY-RUN"
    else
      # PRESENCE ONLY — no -w, ever. Values are never read here [X2].
      if security find-generic-password -a "$probe_user" -s "$svc" >/dev/null 2>&1; then
        status="PRESENT"
      else
        status="MISSING"
        rc=1
      fi
    fi
  fi

  printf 'probe\t%s\t%s\t%s\n' "$label" "$svc" "$status"
  t3_block="${t3_block}#   CLAUDE_CONFIG_DIR=$dir CLAUDE_SECURESTORAGE_CONFIG_DIR=$dir claude auth status --json
"
done <<EOF_MANIFESTS
$manifests
EOF_MANIFESTS

echo "#"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "# DRY-RUN: expected service names computed; keychain NOT touched."
fi
echo "# Presence is necessary, not sufficient. Next (T3, owner-run) prove VALUE"
echo "# access in the broker's own context, one command per account:"
printf '%s' "$t3_block"
echo "# (docs/runbooks/login-bootstrap.md §4 — never run these from SSH/Background"
echo "#  contexts; the login keychain must be unlocked in an Aqua session.)"

exit "$rc"
