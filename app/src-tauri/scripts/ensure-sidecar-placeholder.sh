#!/usr/bin/env bash
# ensure-sidecar-placeholder.sh — guarantee a VALID externalBin exists so the
# tauri-build step's resource-existence check passes for a plain `cargo build`
# / `--smoke-test` (SI-6 packaging, M6).
#
# WHY THIS EXISTS: tauri-build validates that every `bundle.externalBin` file
# exists at COMPILE time — even for a debug `cargo build`, and even though the
# sidecar is only actually copied/signed at `tauri build` (bundle) time. The M2
# scaffold left the sidecar unconfigured precisely because "the binary must
# exist at build time"; M6 flips externalBin ON, so the debug build now needs
# a stand-in. This script provides one WITHOUT the heavyweight real bundle:
#
#   * If a REAL sidecar (built by build-sidecar.sh) is already present, it is
#     left untouched — this script never clobbers a real artifact.
#   * Otherwise it drops a tiny, genuinely-valid Mach-O stub that exits 0. The
#     stub is `/usr/bin/true` copied under the Tauri <name>-<triple> name (a
#     real, signed system binary — not a fake we hand-roll). It is enough for
#     the resource check + a debug/--smoke-test build; it is NEVER the shipped
#     sidecar (build-sidecar.sh overwrites it during `tauri build`).
#
# The stub is gitignored (binaries/.gitignore) and target-specific — it is a
# build artifact, never committed. [X2]: no identity/secret involved.
#
# Exit codes: 0 = a valid externalBin is present · 1 = could not ensure one.

set -euo pipefail

SRC_TAURI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$SRC_TAURI_DIR/binaries"

log() { printf 'ensure-sidecar-placeholder: %s\n' "$*" >&2; }
die() { printf 'ensure-sidecar-placeholder: ERROR: %s\n' "$*" >&2; exit 1; }

if [ -n "${AIBENDER_SIDECAR_TRIPLE:-}" ]; then
  TRIPLE="$AIBENDER_SIDECAR_TRIPLE"
elif command -v rustc >/dev/null 2>&1; then
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
else
  die "cannot determine target triple: rustc not on PATH and AIBENDER_SIDECAR_TRIPLE unset"
fi
[ -n "$TRIPLE" ] || die "empty target triple"

SIDECAR="$OUT_DIR/aibender-core-$TRIPLE"
mkdir -p "$OUT_DIR"

if [ -x "$SIDECAR" ]; then
  log "sidecar already present (left untouched): ${SIDECAR#"$SRC_TAURI_DIR"/}"
  exit 0
fi

# A real, valid, exit-0 executable. /usr/bin/true is a signed system Mach-O on
# macOS; on Linux CI it is an ELF that also exits 0 — either satisfies the
# resource-existence check and runs harmlessly if ever exec'd.
if [ -x /usr/bin/true ]; then
  cp -f /usr/bin/true "$SIDECAR"
elif command -v true >/dev/null 2>&1; then
  cp -f "$(command -v true)" "$SIDECAR"
else
  # Last-resort portable stub (shebang script is a valid executable everywhere).
  printf '#!/bin/sh\nexit 0\n' > "$SIDECAR"
fi
chmod +x "$SIDECAR"
log "placeholder sidecar written (debug/smoke build only): ${SIDECAR#"$SRC_TAURI_DIR"/}"
