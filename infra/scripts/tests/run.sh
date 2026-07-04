#!/usr/bin/env bash
# run.sh — SI infra test runner (invoked by `pnpm run test:infra`).
#
# 1. shellcheck over the SI-2 account scripts (lint is skipped with a warning
#    when the linter is not installed — CI should install it).
# 2. bats suite in this directory, fully headless: every test runs against a
#    temp $AIBENDER_HOME and either --dry-run or a stubbed security(1); the
#    real keychain and real account dirs are NEVER touched (those are T3,
#    owner-run — see docs/runbooks/login-bootstrap.md / version-gate.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACCOUNTS_DIR="$ROOT/infra/scripts/accounts"
TESTS_DIR="$ROOT/infra/scripts/tests"

fail() {
  printf 'test:infra: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "jq is required (macOS: preinstalled; Linux: apt-get install jq)"
command -v bats >/dev/null 2>&1 || fail "bats is required: brew install bats-core (or apt-get install bats)"
if ! command -v python3 >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  fail "python3 or node is required for NFC normalization"
fi

if command -v shellcheck >/dev/null 2>&1; then
  echo "test:infra: shellcheck (accounts scripts + runner)"
  (cd "$ROOT" && shellcheck \
    "$ACCOUNTS_DIR/lib.sh" \
    "$ACCOUNTS_DIR/provision-accounts.sh" \
    "$ACCOUNTS_DIR/keychain-probe.sh" \
    "$ACCOUNTS_DIR/version-gate.sh" \
    "$TESTS_DIR/run.sh")
else
  echo "test:infra: WARN — shellcheck not installed, lint skipped (brew install shellcheck)" >&2
fi

echo "test:infra: bats $TESTS_DIR"
exec bats "$TESTS_DIR"
