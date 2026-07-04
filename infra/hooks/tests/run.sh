#!/usr/bin/env bash
# run.sh — SI-3 hooks test runner (settings templates + installer + statusline tee).
#
# 1. shellcheck (-x to follow sourced libs) over the SI-3 hook scripts.
# 2. bats suite, fully headless: every test runs against a temp
#    $AIBENDER_HOME provisioned by the SI-2 script and synthesized fixture
#    settings.json trees. The real ~/.aibender and real account dirs are
#    NEVER touched — live install is T3, owner-run
#    (docs/runbooks/hooks-telemetry.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOOKS_DIR="$ROOT/infra/hooks"
TESTS_DIR="$HOOKS_DIR/tests"

fail() {
  printf 'test:hooks: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "jq is required (macOS: preinstalled; Linux: apt-get install jq)"
command -v bats >/dev/null 2>&1 || fail "bats is required: brew install bats-core (or apt-get install bats)"

if command -v shellcheck >/dev/null 2>&1; then
  echo "test:hooks: shellcheck (hook scripts + runner)"
  (cd "$ROOT" && shellcheck -x \
    "$HOOKS_DIR/lib.sh" \
    "$HOOKS_DIR/install-hook-settings.sh" \
    "$HOOKS_DIR/uninstall-hook-settings.sh" \
    "$HOOKS_DIR/statusline/aibender-statusline.sh" \
    "$TESTS_DIR/run.sh")
else
  echo "test:hooks: WARN — shellcheck not installed, lint skipped (brew install shellcheck)" >&2
fi

echo "test:hooks: bats $TESTS_DIR"
exec bats "$TESTS_DIR"
