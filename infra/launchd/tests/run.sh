#!/usr/bin/env bash
# run.sh — SI-3 launchd test runner (plist templates + render script).
#
# 1. shellcheck (-x to follow the sourced accounts lib) over the render script
#    and this runner; skipped with a warning when shellcheck is absent.
# 2. bats suite, fully headless: every test renders into a temp
#    $AIBENDER_HOME and stubs launchctl/security to prove they are NEVER
#    executed. Live bootstrap is T3, owner-run (docs/runbooks/launchd.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LAUNCHD_DIR="$ROOT/infra/launchd"
TESTS_DIR="$LAUNCHD_DIR/tests"

fail() {
  printf 'test:launchd: %s\n' "$*" >&2
  exit 1
}

command -v bats >/dev/null 2>&1 || fail "bats is required: brew install bats-core (or apt-get install bats)"

if command -v shellcheck >/dev/null 2>&1; then
  echo "test:launchd: shellcheck (render script + runner)"
  (cd "$ROOT" && shellcheck -x \
    "$LAUNCHD_DIR/render-launchd.sh" \
    "$TESTS_DIR/run.sh")
else
  echo "test:launchd: WARN — shellcheck not installed, lint skipped (brew install shellcheck)" >&2
fi

echo "test:launchd: bats $TESTS_DIR"
exec bats "$TESTS_DIR"
