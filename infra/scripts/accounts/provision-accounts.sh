#!/usr/bin/env bash
# provision-accounts.sh — create the per-account config dirs ([X1] host side, SI-2).
#
# Creates $AIBENDER_HOME/accounts/{max-a,max-b,ent}/ (0700) from the profile
# manifests in infra/profiles/, pins the CLAUDE_CONFIG_DIR +
# CLAUDE_SECURESTORAGE_CONFIG_DIR convention (both = the same byte-stable
# absolute string), and records a provenance marker per dir.
#
# Guarantees:
#   * idempotent — a second run is a no-op that reports OK
#   * REFUSES to touch a populated dir it did not provision (a live credential
#     store must never be clobbered); refusal exits non-zero
#   * --dry-run mutates nothing and works headlessly on any OS
#
# Usage:
#   provision-accounts.sh [--dry-run] [--aibender-home DIR] [--profiles-dir DIR]
#
# Exit codes: 0 = all accounts CREATED/ADOPTED/OK · 1 = refusal or error.
#
# Sources: blueprint §3, plan §6/SI-2, docs/runbooks/login-bootstrap.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/accounts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

DRY_RUN=0
HOME_OVERRIDE=""
PROFILES_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --aibender-home) shift; HOME_OVERRIDE="${1:?--aibender-home needs a value}" ;;
    --profiles-dir) shift; PROFILES_DIR="${1:?--profiles-dir needs a value}" ;;
    -h|--help) usage; exit 0 ;;
    *) aib_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

aib_require_cmds jq
AIB_HOME="$(aib_home_resolve "$HOME_OVERRIDE")"
[ -n "$PROFILES_DIR" ] || PROFILES_DIR="$(aib_default_profiles_dir "$SCRIPT_DIR")"

umask 077
rc=0
now_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
pin_block=""

provision_one() {
  # Prints "provision<TAB>LABEL<TAB>DIR<TAB>STATUS"; returns 1 on REFUSED.
  local label="$1" dir="$2"
  local marker="$dir/$AIB_MARKER_NAME" status="" reason="" mlabel="" mdir=""

  if [ ! -d "$dir" ]; then
    status="CREATED"
  elif [ -f "$marker" ]; then
    mlabel="$(jq -r '.label // empty' "$marker" 2>/dev/null || true)"
    mdir="$(jq -r '.dir // empty' "$marker" 2>/dev/null || true)"
    if [ "$mlabel" = "$label" ] && [ "$mdir" = "$dir" ]; then
      status="OK"
    else
      status="REFUSED"
      reason="marker mismatch (marker label='$mlabel' dir='$mdir'; expected label='$label' dir='$dir') — dir belongs to something else; resolve manually, see docs/runbooks/login-bootstrap.md"
    fi
  elif [ -z "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    status="ADOPTED" # exists but empty — safe to claim
  else
    status="REFUSED"
    reason="dir is populated but has no provenance marker — refusing to overwrite a possibly-live credential store. Inspect it, then either move it aside or provision manually (docs/runbooks/login-bootstrap.md §troubleshooting)."
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'provision\t%s\t%s\tPLAN-%s\n' "$label" "$dir" "$status"
    [ -n "$reason" ] && aib_warn "$label: $reason"
  else
    case "$status" in
      CREATED|ADOPTED)
        mkdir -p "$dir"
        chmod 700 "$dir" "$AIB_HOME/accounts" "$AIB_HOME"
        jq -n \
          --arg label "$label" \
          --arg dir "$dir" \
          --arg at "$now_utc" \
          '{schemaVersion: 1, label: $label, dir: $dir,
            claudeConfigDir: $dir, claudeSecurestorageConfigDir: $dir,
            provisionedAt: $at,
            note: "the-last-aibender SI-2 provenance marker — the dir string above is the BYTE-STABLE value to pass on every launch"}' \
          > "$marker"
        chmod 600 "$marker"
        ;;
      OK)
        : # idempotent no-op; never rewrite the marker or touch contents
        ;;
      REFUSED)
        aib_warn "$label: $reason"
        ;;
    esac
    printf 'provision\t%s\t%s\t%s\n' "$label" "$dir" "$status"
  fi

  pin_block="${pin_block}#   $label:
#     CLAUDE_CONFIG_DIR=$dir
#     CLAUDE_SECURESTORAGE_CONFIG_DIR=$dir
"
  [ "$status" = "REFUSED" ] && return 1
  return 0
}

manifests="$(aib_profile_files "$PROFILES_DIR")"
[ -n "$manifests" ] || aib_die "no *.profile.json manifests found in $PROFILES_DIR"

while IFS= read -r f; do
  resolved="$(aib_profile_resolve "$f" "$AIB_HOME")"
  label="${resolved%%$'\t'*}"
  dir="${resolved#*$'\t'}"
  case "$dir" in
    "$AIB_HOME"/accounts/*) : ;;
    *) aib_die "manifest $f resolves outside \$AIBENDER_HOME/accounts/: $dir" ;;
  esac
  provision_one "$label" "$dir" || rc=1
done <<EOF_MANIFESTS
$manifests
EOF_MANIFESTS

echo "#"
echo "# Pinned per-account env (byte-stable absolute strings — pass EXACTLY these,"
echo "# same bytes, every launch; blueprint §3 rule 2):"
printf '%s' "$pin_block"
echo "#"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "# DRY-RUN: nothing was created. Re-run without --dry-run to provision."
else
  echo "# Next: one interactive login per account — docs/runbooks/login-bootstrap.md"
fi

exit "$rc"
