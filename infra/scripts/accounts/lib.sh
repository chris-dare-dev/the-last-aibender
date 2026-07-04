# shellcheck shell=bash
# lib.sh — shared helpers for the SI-2 account provisioning / keychain scripts.
#
# SOURCED, never executed. Bash 3.2-compatible (macOS system bash) on purpose:
# no associative arrays, no ${var^^}.
#
# [X2]: this library never reads, prints, or stores credential VALUES. The only
# keychain interaction anywhere in infra/scripts/accounts/ is a PRESENCE probe
# (`security find-generic-password` WITHOUT -w) in keychain-probe.sh.
#
# Keychain service-name derivation implemented here (aib_service_name) mirrors
# the shipping Claude Code binary — verified by read-only `strings` inspection
# of v2.1.193 (2026-07-04) and by docs/research/findings/x1-parallel-multi-account.md:
#
#   service = "Claude Code" + OAUTH_FILE_SUFFIX + "-credentials"
#             + "-" + first 8 hex of sha256( NFC(securestorage dir string) )
#   account attribute = $USER
#
# OAUTH_FILE_SUFFIX is empty in prod builds, so the default base is
# "Claude Code-credentials". The base is parameterized via
# AIBENDER_KEYCHAIN_SERVICE_BASE because the derivation is undocumented
# upstream and may change in any SDK bump (that is what version-gate.sh gates).

# shellcheck disable=SC2034  # consumed by the sourcing scripts
AIB_MARKER_NAME=".aibender-account.json"
AIB_DEFAULT_SERVICE_BASE="Claude Code-credentials"

aib_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

aib_warn() {
  printf 'WARN: %s\n' "$*" >&2
}

aib_require_cmds() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || aib_die "required command not found on PATH: $c"
  done
}

# Canonicalize an AIBENDER_HOME value: must be absolute; trailing slashes are
# stripped deterministically. This canonical string feeds the byte-stable dir
# convention (blueprint §3 rule 2) — never realpath/symlink-resolve it.
aib_home_canon() {
  local h="$1"
  [ -n "$h" ] || aib_die "AIBENDER_HOME is empty"
  case "$h" in
    /*) : ;;
    *) aib_die "AIBENDER_HOME must be an absolute path (byte-stable convention, no '~' or relative paths): $h" ;;
  esac
  while [ "${h%/}" != "$h" ] && [ "$h" != "/" ]; do h="${h%/}"; done
  printf '%s' "$h"
}

# Resolve AIBENDER_HOME from an override arg, the env, or the default.
aib_home_resolve() {
  local override="${1:-}"
  local h
  if [ -n "$override" ]; then
    h="$override"
  elif [ -n "${AIBENDER_HOME:-}" ]; then
    h="$AIBENDER_HOME"
  else
    h="${HOME:?HOME is unset}/.aibender"
  fi
  aib_home_canon "$h"
}

# NFC-normalize a string (the CLI normalizes the dir before hashing).
aib_nfc() {
  local s="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,unicodedata; sys.stdout.write(unicodedata.normalize("NFC", sys.argv[1]))' "$s"
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(process.argv[1].normalize("NFC"))' "$s"
  else
    aib_die "NFC normalization needs python3 or node on PATH"
  fi
}

aib_sha256_hex() {
  local s="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$s" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$s" | sha256sum | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$s" | openssl dgst -sha256 -hex | awk '{print $NF}'
  else
    aib_die "sha256 needs shasum, sha256sum, or openssl on PATH"
  fi
}

aib_hash8() {
  local hex
  hex="$(aib_sha256_hex "$1")" || return 1
  printf '%s' "${hex:0:8}"
}

# Expected keychain service name for a securestorage dir string, exactly as
# the broker will pass it (raw, byte-stable). See header for the derivation.
aib_service_name() {
  local dir="$1" base nfc
  base="${AIBENDER_KEYCHAIN_SERVICE_BASE:-$AIB_DEFAULT_SERVICE_BASE}"
  nfc="$(aib_nfc "$dir")" || return 1
  printf '%s-%s' "$base" "$(aib_hash8 "$nfc")"
}

# List profile manifests, deterministic order.
aib_profile_files() {
  local dir="$1"
  [ -d "$dir" ] || aib_die "profiles dir not found: $dir"
  find "$dir" -maxdepth 1 -name '*.profile.json' -print 2>/dev/null | LC_ALL=C sort
}

# Expand a manifest path convention ("$AIBENDER_HOME/...") against a canonical
# home. Literal prefix replacement ONLY — see infra/profiles/README.md.
aib_expand_convention() {
  local conv="$1" home="$2"
  # shellcheck disable=SC2016  # the literal string $AIBENDER_HOME is the convention
  case "$conv" in
    '$AIBENDER_HOME'/*) printf '%s/%s' "$home" "${conv#\$AIBENDER_HOME/}" ;;
    *) aib_die "manifest path convention must start with \$AIBENDER_HOME/ (got: $conv)" ;;
  esac
}

# Resolve one manifest → "LABEL<TAB>DIR". Validates the securestorage pin.
aib_profile_resolve() {
  local f="$1" home="$2" label conf ss dir
  label="$(jq -er '.label' "$f")" || aib_die "manifest $f: missing/invalid .label"
  case "$label" in
    MAX_A|MAX_B|ENT) : ;;
    *) aib_die "manifest $f: label '$label' is not a sanctioned placeholder (MAX_A|MAX_B|ENT) [X2]" ;;
  esac
  conf="$(jq -er '.env.CLAUDE_CONFIG_DIR' "$f")" || aib_die "manifest $f: missing .env.CLAUDE_CONFIG_DIR"
  ss="$(jq -er '.env.CLAUDE_SECURESTORAGE_CONFIG_DIR' "$f")" || aib_die "manifest $f: missing .env.CLAUDE_SECURESTORAGE_CONFIG_DIR"
  [ "$conf" = "$ss" ] || aib_die "manifest $f: CLAUDE_SECURESTORAGE_CONFIG_DIR must be PINNED equal to CLAUDE_CONFIG_DIR (blueprint §3) — got '$conf' vs '$ss'"
  dir="$(aib_expand_convention "$conf" "$home")"
  printf '%s\t%s' "$label" "$dir"
}

# Default profiles dir relative to a caller's script dir (infra/scripts/accounts).
aib_default_profiles_dir() {
  local script_dir="$1" d
  d="$script_dir/../../profiles"
  [ -d "$d" ] || aib_die "default profiles dir not found: $d (pass --profiles-dir)"
  (cd "$d" && pwd)
}
