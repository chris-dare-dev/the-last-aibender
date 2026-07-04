#!/usr/bin/env bash
# apply-branch-protection.sh — branch protection for `main` as code (SI-6).
#
# PENDING-OWNER, NEVER run by CI or by agents: applying branch protection is
# an external GitHub mutation (External System Write Policy). The desired
# state lives in infra/ci/branch-protection.json; this script shows it, then
# applies it ONLY when BOTH --repo and --yes are given.
#
# Usage:
#   apply-branch-protection.sh --repo OWNER/NAME [--branch main] [--yes]
#
#   --repo OWNER/NAME  the GitHub repository (required; never inferred so a
#                      fork/mirror can't be mutated by accident)
#   --branch NAME      branch to protect (default: main)
#   --yes              actually apply. Without it this is a DRY-RUN that
#                      prints the config and the exact gh command, exit 0.
#
# Requires: gh (authenticated) — only on the --yes path; jq.
# The status-check contexts in the JSON must match the ci.yml job names —
# see infra/ci/README.md before editing either side.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/branch-protection.json"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'apply-branch-protection: %s\n' "$*" >&2
  exit 2
}

REPO=""
BRANCH="main"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift; REPO="${1:?--repo needs OWNER/NAME}" ;;
    --branch) shift; BRANCH="${1:?--branch needs a value}" ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[ -n "$REPO" ] || die "--repo OWNER/NAME is required (never inferred)"
case "$REPO" in
  */*) : ;;
  *) die "--repo must be OWNER/NAME, got: $REPO" ;;
esac
[ -f "$CONFIG" ] || die "config not found: $CONFIG"

command -v jq >/dev/null 2>&1 || die "jq is required"
jq -e . "$CONFIG" >/dev/null || die "config is not valid JSON: $CONFIG"

echo "apply-branch-protection: desired state for $REPO@$BRANCH ($CONFIG):"
jq . "$CONFIG"

if [ "$YES" -ne 1 ]; then
  cat <<EOF
DRY-RUN: nothing applied. After reviewing the config above, the owner runs:

  infra/ci/apply-branch-protection.sh --repo $REPO --branch $BRANCH --yes

(This mutates GitHub — owner-run only, per the External System Write Policy.)
EOF
  exit 0
fi

command -v gh >/dev/null 2>&1 || die "gh is required on the --yes path (brew install gh)"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth login — owner-run)"

# The $comment key is documentation for humans; strip it before the API call.
jq 'del(."$comment")' "$CONFIG" | gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/$REPO/branches/$BRANCH/protection" \
  --input -
echo "apply-branch-protection: applied to $REPO@$BRANCH"
