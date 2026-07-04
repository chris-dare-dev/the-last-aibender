#!/usr/bin/env bats
# accounts.bats — SI-2 account provisioning & keychain verification tests.
#
# Plan §9.2 SI-2 row:
#   positive — probe recomputes expected service names
#   negative — probe never uses -w (static + runtime stub log);
#              provisioning refuses to overwrite a populated config dir
#   edge     — non-NFC path input; hash-suffix mismatch after a simulated
#              SDK bump → version gate BLOCKs
#
# Fully headless [X2/T3 boundary]: every test targets a temp $AIBENDER_HOME
# and uses --dry-run or a stubbed security(1). The real keychain and the real
# ~/.aibender are never touched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPTS="$REPO_ROOT/infra/scripts/accounts"
  export AIBENDER_HOME="$BATS_TEST_TMPDIR/aibhome"
  # Hermetic version capture for version-gate --init (never invoke a real CLI).
  export AIBENDER_CLAUDE_BIN=true
  unset AIBENDER_KEYCHAIN_SERVICE_BASE 2>/dev/null || true
}

# --- helpers -----------------------------------------------------------------

hash8() { # sha256 hex[0:8] of the RAW string bytes
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -c1-8
  else
    printf '%s' "$1" | sha256sum | cut -c1-8
  fi
}

nfc_hash8() { # sha256 hex[0:8] of the NFC-normalized string — independent impl
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,unicodedata,hashlib; s=unicodedata.normalize("NFC", sys.argv[1]); sys.stdout.write(hashlib.sha256(s.encode()).hexdigest()[:8])' "$1"
  else
    node -e 'const c=require("crypto");process.stdout.write(c.createHash("sha256").update(process.argv[1].normalize("NFC")).digest("hex").slice(0,8))' "$1"
  fi
}

perms() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

make_security_stub() { # $1 = stub dir; control via SECURITY_STUB_LOG / SECURITY_STUB_MISSING
  mkdir -p "$1"
  cat > "$1/security" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SECURITY_STUB_LOG:?}"
svc=""
prev=""
for a in "$@"; do
  [ "$prev" = "-s" ] && svc="$a"
  prev="$a"
done
case "$svc" in
  *"${SECURITY_STUB_MISSING:-__none__}"*) exit 44 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$1/security"
}

# --- provisioning: positive ----------------------------------------------------

@test "provision --dry-run plans all three accounts and creates nothing" {
  run "$SCRIPTS/provision-accounts.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"PLAN-CREATED"* ]]
  [[ "$output" == *"$AIBENDER_HOME/accounts/max-a"* ]]
  [[ "$output" == *"$AIBENDER_HOME/accounts/max-b"* ]]
  [[ "$output" == *"$AIBENDER_HOME/accounts/ent"* ]]
  [ ! -e "$AIBENDER_HOME" ]
}

@test "provision creates the three dirs 0700 with provenance markers" {
  run "$SCRIPTS/provision-accounts.sh"
  [ "$status" -eq 0 ]
  for a in max-a max-b ent; do
    d="$AIBENDER_HOME/accounts/$a"
    [ -d "$d" ]
    [ "$(perms "$d")" = "700" ]
    [ -f "$d/.aibender-account.json" ]
  done
  [ "$(perms "$AIBENDER_HOME")" = "700" ]
  [ "$(perms "$AIBENDER_HOME/accounts")" = "700" ]
  run jq -r '.label' "$AIBENDER_HOME/accounts/max-b/.aibender-account.json"
  [ "$output" = "MAX_B" ]
  run jq -r '.claudeSecurestorageConfigDir' "$AIBENDER_HOME/accounts/ent/.aibender-account.json"
  [ "$output" = "$AIBENDER_HOME/accounts/ent" ]
}

@test "provision is idempotent (second run reports OK, exit 0)" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  run "$SCRIPTS/provision-accounts.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'provision\tMAX_A\t'*$'\tOK'* ]]
  [[ "$output" != *"CREATED"* ]]
}

@test "provision stays OK after the account dir gets populated by a login" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  # simulate CLI-written state after `claude /login`
  touch "$AIBENDER_HOME/accounts/max-a/settings.json"
  mkdir -p "$AIBENDER_HOME/accounts/max-a/projects"
  run "$SCRIPTS/provision-accounts.sh"
  [ "$status" -eq 0 ]
  [ -f "$AIBENDER_HOME/accounts/max-a/settings.json" ]
}

# --- provisioning: negative ----------------------------------------------------

@test "provision REFUSES a populated dir without a marker and touches nothing" {
  mkdir -p "$AIBENDER_HOME/accounts/max-a"
  printf 'live-credential-ish\n' > "$AIBENDER_HOME/accounts/max-a/.credentials.json"
  run "$SCRIPTS/provision-accounts.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *$'provision\tMAX_A\t'*$'\tREFUSED'* ]]
  [ "$(cat "$AIBENDER_HOME/accounts/max-a/.credentials.json")" = "live-credential-ish" ]
  [ ! -f "$AIBENDER_HOME/accounts/max-a/.aibender-account.json" ]
  # the other two accounts still provision
  [ -f "$AIBENDER_HOME/accounts/max-b/.aibender-account.json" ]
}

@test "provision REFUSES on marker label mismatch" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  m="$AIBENDER_HOME/accounts/max-b/.aibender-account.json"
  jq '.label = "MAX_A"' "$m" > "$m.tmp" && mv "$m.tmp" "$m"
  run "$SCRIPTS/provision-accounts.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *$'provision\tMAX_B\t'*$'\tREFUSED'* ]]
}

@test "provision rejects a relative AIBENDER_HOME (byte-stability guard)" {
  run env AIBENDER_HOME="rel/path" "$SCRIPTS/provision-accounts.sh" --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *"absolute path"* ]]
}

# --- keychain probe: positive ---------------------------------------------------

@test "probe --dry-run recomputes the expected per-account service names" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  run "$SCRIPTS/keychain-probe.sh" --dry-run
  [ "$status" -eq 0 ]
  for a in max-a max-b ent; do
    exp="$(hash8 "$AIBENDER_HOME/accounts/$a")"
    [[ "$output" == *"Claude Code-credentials-$exp"* ]]
  done
  [[ "$output" == *"DRY-RUN"* ]]
  [[ "$output" == *"claude auth status --json"* ]]
}

@test "service-name derivation matches the verified known vector" {
  # sha256("/aibender/test/accounts/max-a")[0:8] = c8db9bbb (precomputed)
  run bash -c "source '$SCRIPTS/lib.sh'; aib_service_name '/aibender/test/accounts/max-a'"
  [ "$status" -eq 0 ]
  [ "$output" = "Claude Code-credentials-c8db9bbb" ]
}

@test "probe with stubbed security reports PRESENT for every account, exit 0" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  stub="$BATS_TEST_TMPDIR/stub-all"
  make_security_stub "$stub"
  log="$BATS_TEST_TMPDIR/sec-all.log"
  run env PATH="$stub:$PATH" SECURITY_STUB_LOG="$log" "$SCRIPTS/keychain-probe.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'probe\tMAX_A\t'*$'\tPRESENT'* ]]
  [[ "$output" == *$'probe\tENT\t'*$'\tPRESENT'* ]]
}

# --- keychain probe: negative ---------------------------------------------------

@test "probe never passes -w to security (static check over the scripts)" {
  run bash -c "grep -nE '^[^#]*security[^#]*[[:space:]]-w' \
    '$SCRIPTS/keychain-probe.sh' '$SCRIPTS/lib.sh' \
    '$SCRIPTS/provision-accounts.sh' '$SCRIPTS/version-gate.sh'"
  [ "$status" -ne 0 ]
}

@test "probe reports MISSING (exit 1) and its security calls carry no -w" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  stub="$BATS_TEST_TMPDIR/stub-miss"
  make_security_stub "$stub"
  log="$BATS_TEST_TMPDIR/sec-miss.log"
  missing_suffix="$(hash8 "$AIBENDER_HOME/accounts/max-b")"
  run env PATH="$stub:$PATH" SECURITY_STUB_LOG="$log" \
    SECURITY_STUB_MISSING="$missing_suffix" "$SCRIPTS/keychain-probe.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *$'probe\tMAX_B\t'*$'\tMISSING'* ]]
  [[ "$output" == *$'probe\tMAX_A\t'*$'\tPRESENT'* ]]
  grep -q 'find-generic-password' "$log"
  ! grep -qE '(^| )-w( |$)' "$log"
}

@test "probe flags byte-stability DRIFT when the marker dir disagrees" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  m="$AIBENDER_HOME/accounts/ent/.aibender-account.json"
  jq '.dir = "/somewhere/else/ent"' "$m" > "$m.tmp" && mv "$m.tmp" "$m"
  run "$SCRIPTS/keychain-probe.sh" --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *$'probe\tENT\t'*$'\tDRIFT'* ]]
}

# --- edge: NFC normalization ----------------------------------------------------

@test "non-NFC (NFD) path input is NFC-normalized before hashing (lib vector)" {
  # NFC("/tmp/áccounts") → d12295f3 ; raw NFD bytes → 2aa66eca (both precomputed)
  nfd="$(printf '/tmp/a\xcc\x81ccounts')"
  run bash -c "source '$SCRIPTS/lib.sh'; aib_service_name '$nfd'"
  [ "$status" -eq 0 ]
  [ "$output" = "Claude Code-credentials-d12295f3" ]
  [[ "$output" != *"2aa66eca"* ]]
}

@test "probe end-to-end with an NFD AIBENDER_HOME hashes the NFC form" {
  nfd_home="$(printf '%s/a\xcc\x81ibhome' "$BATS_TEST_TMPDIR")"
  dir="$nfd_home/accounts/max-a"
  exp="$(nfc_hash8 "$dir")"
  raw="$(hash8 "$dir")"
  run env AIBENDER_HOME="$nfd_home" "$SCRIPTS/keychain-probe.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude Code-credentials-$exp"* ]]
  if [ "$raw" != "$exp" ]; then
    [[ "$output" != *"Claude Code-credentials-$raw"* ]]
  fi
}

@test "trailing slashes on AIBENDER_HOME canonicalize to the same service names" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  run "$SCRIPTS/keychain-probe.sh" --dry-run
  clean_line="$(printf '%s\n' "$output" | grep $'^probe\tMAX_A\t')"
  run env AIBENDER_HOME="$AIBENDER_HOME///" "$SCRIPTS/keychain-probe.sh" --dry-run
  [ "$status" -eq 0 ]
  slash_line="$(printf '%s\n' "$output" | grep $'^probe\tMAX_A\t')"
  [ "$clean_line" = "$slash_line" ]
}

# --- version gate ----------------------------------------------------------------

@test "version-gate BLOCKs when no baseline exists" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  run "$SCRIPTS/version-gate.sh" --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *"no baseline"* ]]
  [[ "$output" == *"RESULT: BLOCK"* ]]
}

@test "version-gate --init writes a 600 baseline; dry-run gate then PASSes" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  run "$SCRIPTS/version-gate.sh" --init
  [ "$status" -eq 0 ]
  state="$AIBENDER_HOME/state/version-gate.json"
  [ -f "$state" ]
  [ "$(perms "$state")" = "600" ]
  run jq -r '.serviceBase' "$state"
  [ "$output" = "Claude Code-credentials" ]
  run "$SCRIPTS/version-gate.sh" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *$'gate\tMAX_A\t'*$'\tMATCH'* ]]
  [[ "$output" == *"RESULT: PASS"* ]]
  [[ "$output" == *"ADVISORY"* ]]
}

@test "version-gate --init --dry-run previews but writes nothing" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  run "$SCRIPTS/version-gate.sh" --init --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"would write baseline"* ]]
  [ ! -e "$AIBENDER_HOME/state/version-gate.json" ]
}

@test "version-gate BLOCKs on hash-suffix mismatch after a simulated SDK bump" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  "$SCRIPTS/version-gate.sh" --init >/dev/null
  # a bump that changes the derivation shows up as a different expected name
  run "$SCRIPTS/version-gate.sh" --dry-run --service-base "Claude Code-credentials-v9"
  [ "$status" -eq 1 ]
  [[ "$output" == *"MISMATCH"* ]]
  [[ "$output" == *"RESULT: BLOCK"* ]]
}

@test "version-gate BLOCKs when the baseline matches but a keychain item is gone" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  "$SCRIPTS/version-gate.sh" --init >/dev/null
  stub="$BATS_TEST_TMPDIR/stub-gate"
  make_security_stub "$stub"
  log="$BATS_TEST_TMPDIR/sec-gate.log"
  missing_suffix="$(hash8 "$AIBENDER_HOME/accounts/ent")"
  run env PATH="$stub:$PATH" SECURITY_STUB_LOG="$log" \
    SECURITY_STUB_MISSING="$missing_suffix" "$SCRIPTS/version-gate.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *$'gate\tENT\t'*$'\tMATCH'* ]]
  [[ "$output" == *$'probe\tENT\t'*$'\tMISSING'* ]]
  [[ "$output" == *"RESULT: BLOCK"* ]]
}

@test "version-gate PASSes with stubbed security when everything lines up" {
  "$SCRIPTS/provision-accounts.sh" >/dev/null
  "$SCRIPTS/version-gate.sh" --init >/dev/null
  stub="$BATS_TEST_TMPDIR/stub-pass"
  make_security_stub "$stub"
  log="$BATS_TEST_TMPDIR/sec-pass.log"
  run env PATH="$stub:$PATH" SECURITY_STUB_LOG="$log" "$SCRIPTS/version-gate.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"RESULT: PASS"* ]]
  # PASS output still points at the T3 canary — never executed headlessly
  [[ "$output" == *"canary"* ]]
}
