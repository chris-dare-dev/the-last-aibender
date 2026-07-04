#!/usr/bin/env bash
# run.sh — SI-6 CI-scripts test runner (invoked by ci.yml's infra-tests job;
# runnable locally the same way: `bash infra/ci/tests/run.sh`).
#
# 1. shellcheck over every infra/ci shell script (lint is skipped with a
#    warning when the linter is not installed — CI installs it).
# 2. bats suite in this directory, fully headless: live-check.sh runs against
#    temp homes, stripped PATHs, and stub binaries — the real keychain, real
#    accounts, real LM Studio, and a real `opencode serve` are NEVER touched
#    here (those are the T3 live checks themselves, owner-run).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CI_DIR="$ROOT/infra/ci"
TESTS_DIR="$ROOT/infra/ci/tests"

fail() {
  printf 'ci-tests: %s\n' "$*" >&2
  exit 1
}

command -v bats >/dev/null 2>&1 || fail "bats is required: brew install bats-core (or apt-get install bats)"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required (macOS: preinstalled; Linux: apt-get install jq)"

if command -v shellcheck >/dev/null 2>&1; then
  echo "ci-tests: shellcheck (infra/ci scripts + this runner)"
  (cd "$ROOT" && shellcheck \
    "$CI_DIR/live-check.sh" \
    "$CI_DIR/playwright-browsers.sh" \
    "$CI_DIR/apply-branch-protection.sh" \
    "$TESTS_DIR/run.sh")
else
  echo "ci-tests: WARN — shellcheck not installed, lint skipped (brew install shellcheck)" >&2
fi

echo "ci-tests: bats $TESTS_DIR"
exec bats "$TESTS_DIR"
