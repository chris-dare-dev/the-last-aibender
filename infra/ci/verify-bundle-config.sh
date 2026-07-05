#!/usr/bin/env bash
# verify-bundle-config.sh — static validator for the v0 Tauri packaging config
# (SI-6 packaging, M6). Asserts the bundle SHAPE without building or signing
# anything: it reads app/src-tauri/tauri.conf.json + the sidecar scripts +
# entitlements and checks the invariants the M6 DoD depends on.
#
# WHY A DEDICATED CHECK: the debug `cargo build` proves the crate compiles, but
# the BUNDLE section (active, externalBin, macOS signing DRY-RUN posture,
# entitlements) is only exercised at `tauri build` — which never runs in hosted
# CI (no full bundle, no signing). This script gives CI + the live-check runner
# a cheap, offline assertion that the config stays in the v0-correct shape:
#
#   1. bundle.active == true                 (flipped ON for v0 — was false at M2)
#   2. bundle.externalBin includes the aibender-core sidecar
#   3. macOS.signingIdentity == null         (signing is DRY-RUN — no real identity)
#   4. macOS.entitlements references a file that exists and carries the
#      hardened-runtime JIT entitlements a Node/Bun sidecar needs (spike-e S7)
#   5. the sidecar build script + placeholder script exist and are executable
#   6. beforeBundleCommand invokes the sidecar build script
#
# [X2]: reads config only; no identity/secret is printed or required.
#
# Usage: verify-bundle-config.sh [--conf PATH]
# Exit: 0 = all invariants hold · 1 = a violation · 2 = usage / missing dep.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONF="$ROOT/app/src-tauri/tauri.conf.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --conf) shift; CONF="${1:?--conf needs a value}" ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'verify-bundle-config: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || { printf 'verify-bundle-config: jq is required\n' >&2; exit 2; }
[ -f "$CONF" ] || { printf 'verify-bundle-config: config not found: %s\n' "$CONF" >&2; exit 2; }

SRC_TAURI_DIR="$(cd "$(dirname "$CONF")" && pwd)"
fails=0
note() { printf 'verify-bundle-config: %s\n' "$*" >&2; }
bad()  { printf 'verify-bundle-config: FAIL: %s\n' "$*" >&2; fails=$((fails + 1)); }

# 1. bundle active (flipped ON for v0)
if [ "$(jq -r '.bundle.active' "$CONF")" != "true" ]; then
  bad "bundle.active must be true for the v0 ship (M6 flips the M2 scaffold ON)"
fi

# 2. externalBin declares the sidecar
if ! jq -e '(.bundle.externalBin // []) | any(. == "binaries/aibender-core")' "$CONF" >/dev/null; then
  bad "bundle.externalBin must include \"binaries/aibender-core\" (the aibender-core sidecar)"
fi

# 3. signing is DRY-RUN (no real identity baked into the committed config)
SIGN_ID="$(jq -r '.bundle.macOS.signingIdentity' "$CONF")"
if [ "$SIGN_ID" != "null" ]; then
  bad "macOS.signingIdentity must be null in the committed config (signing is DRY-RUN / owner-gated T3); found: $SIGN_ID"
fi

# 4. entitlements file exists + carries the hardened-runtime JIT keys (spike-e S7)
ENT_REL="$(jq -r '.bundle.macOS.entitlements // ""' "$CONF")"
if [ -z "$ENT_REL" ] || [ "$ENT_REL" = "null" ]; then
  bad "macOS.entitlements must reference an entitlements file (notarization-ready shape)"
else
  ENT="$SRC_TAURI_DIR/$ENT_REL"
  if [ ! -f "$ENT" ]; then
    bad "macOS.entitlements references a missing file: $ENT_REL"
  else
    for key in com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory; do
      grep -q "$key" "$ENT" || bad "entitlements missing hardened-runtime key: $key (a Node/Bun sidecar needs it — spike-e S7)"
    done
  fi
fi

# 5. sidecar build + placeholder scripts present and executable
for s in scripts/build-sidecar.sh scripts/ensure-sidecar-placeholder.sh; do
  if [ ! -f "$SRC_TAURI_DIR/$s" ]; then
    bad "missing sidecar script: $s"
  elif [ ! -x "$SRC_TAURI_DIR/$s" ]; then
    bad "sidecar script not executable: $s"
  fi
done

# 6. beforeBundleCommand invokes the sidecar build
BBC="$(jq -r '.build.beforeBundleCommand // ""' "$CONF")"
case "$BBC" in
  *build-sidecar.sh*) : ;;
  *) bad "build.beforeBundleCommand must invoke build-sidecar.sh (so the sidecar is produced at bundle time); found: '$BBC'" ;;
esac

if [ "$fails" -gt 0 ]; then
  note "$fails invariant(s) violated"
  exit 1
fi
note "OK — v0 bundle config shape valid (active, externalBin sidecar, signing DRY-RUN, entitlements ready)"
