#!/usr/bin/env bash
# run.sh — SI-5 colima test runner (version pins + pod→host loopback probe).
#
# 1. shellcheck (-x to follow the sourced pins file) over the probe + runner.
# 2. bats suite, fully headless: colima/limactl/kubectl are PATH stubs with
#    an invocation log; the only network activity is loopback GETs against a
#    suite-owned python3 fake server. The real VM, the real k3s cluster, and
#    LM Studio are NEVER touched — VM lifecycle is owner-gated
#    (docs/runbooks/colima.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COLIMA_DIR="$ROOT/infra/colima"
TESTS_DIR="$COLIMA_DIR/tests"

fail() {
  printf 'test:colima: %s\n' "$*" >&2
  exit 1
}

command -v bats >/dev/null 2>&1 || fail "bats is required: brew install bats-core (or apt-get install bats)"
command -v curl >/dev/null 2>&1 || fail "curl is required"

if command -v shellcheck >/dev/null 2>&1; then
  echo "test:colima: shellcheck (probe + runner)"
  (cd "$ROOT" && shellcheck -x \
    "$COLIMA_DIR/probe-pod-host-loopback.sh" \
    "$TESTS_DIR/run.sh")
else
  echo "test:colima: WARN — shellcheck not installed, lint skipped (brew install shellcheck)" >&2
fi

echo "test:colima: bats $TESTS_DIR"
exec bats "$TESTS_DIR"
