#!/usr/bin/env bash
# run.sh — SI-4 test runner for the Bedrock cost-attribution IaC.
#
# 1. shellcheck over this runner (the stack itself has no shell scripts —
#    keeping it that way is asserted by the bats suite).
# 2. bats suite, fully offline-safe: variable hygiene greps always run;
#    terraform fmt/validate and the credential-less-plan edge case skip with a
#    message when terraform or the provider plugins are unavailable.
#
# NOTHING here (or anywhere in CI) runs `terraform plan` against live
# credentials or any apply — plan/apply are owner-run and hard-gated
# (docs/runbooks/bedrock-iac.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TESTS_DIR="$ROOT/infra/aws/tests"

fail() {
  printf 'test:aws-iac: %s\n' "$*" >&2
  exit 1
}

command -v bats >/dev/null 2>&1 || fail "bats is required: brew install bats-core (or apt-get install bats)"

if command -v shellcheck >/dev/null 2>&1; then
  echo "test:aws-iac: shellcheck (runner)"
  (cd "$ROOT" && shellcheck "$TESTS_DIR/run.sh")
else
  echo "test:aws-iac: WARN — shellcheck not installed, lint skipped (brew install shellcheck)" >&2
fi

echo "test:aws-iac: bats $TESTS_DIR"
exec bats "$TESTS_DIR"
