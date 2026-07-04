#!/usr/bin/env bash
# playwright-browsers.sh — install Playwright browsers for CI (SI-6).
#
# The ci.yml pipeline must stay green on trees where no workspace package
# depends on playwright yet (FE island component tests land independently).
# This script resolves the playwright CLI from whichever workspace package
# carries it and installs browsers; when none does, it is a clean no-op.
#
# Usage:
#   playwright-browsers.sh [--with-webkit] [--root DIR]
#
#   default        install chromium only (the Linux CI browser)
#   --with-webkit  additionally install webkit (macOS jobs — WebKit-only
#                  specs are tagged per infra/ci/README.md and self-skip on
#                  Linux via AIBENDER_CI_SKIP_WEBKIT=1)
#   --root DIR     workspace root to search (default: this repo; the bats
#                  suite points it at fixture trees)
#
# `--with-deps` (system libraries) is passed on Linux only; macOS runners
# need no extra system packages.

set -euo pipefail

WITH_WEBKIT=0
ROOT_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-webkit) WITH_WEBKIT=1 ;;
    --root) shift; ROOT_OVERRIDE="${1:?--root needs a value}" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'playwright-browsers: unknown argument: %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$ROOT_OVERRIDE" ]; then
  ROOT="$ROOT_OVERRIDE"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

# Search the workspace members (and the root) for a hoisted playwright CLI.
PLAYWRIGHT_BIN=""
for dir in "$ROOT" "$ROOT/app" "$ROOT/core" "$ROOT"/packages/*; do
  candidate="$dir/node_modules/.bin/playwright"
  if [ -x "$candidate" ]; then
    PLAYWRIGHT_BIN="$candidate"
    break
  fi
done

if [ -z "$PLAYWRIGHT_BIN" ]; then
  echo "playwright-browsers: no workspace package depends on playwright — nothing to install (no-op)."
  exit 0
fi

BROWSERS=(chromium)
if [ "$WITH_WEBKIT" -eq 1 ]; then
  BROWSERS+=(webkit)
fi

echo "playwright-browsers: installing ${BROWSERS[*]} via $PLAYWRIGHT_BIN"
if [ "$(uname -s)" = "Linux" ]; then
  "$PLAYWRIGHT_BIN" install --with-deps "${BROWSERS[@]}"
else
  "$PLAYWRIGHT_BIN" install "${BROWSERS[@]}"
fi
