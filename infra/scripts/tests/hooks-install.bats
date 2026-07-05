#!/usr/bin/env bats
# hooks-install.bats — SI-1 tests for the two-tier gitleaks pre-commit gate
# installer (infra/scripts/install-hooks.sh) and the hook it generates.
#
# SEC-4 (Stage-3 review, docs/reviews/security.md): the Tier-2 private config
# (~/.aibender/private/gitleaks-tier2.toml) holds exact private identifier
# literals. The hook already fails closed when it is ABSENT; SEC-4 adds a
# fail-closed permission assertion so a group/world-readable copy (created
# under a permissive umask) can never be run. These tests prove the assertion:
#
#   positive — a mode-600 Tier-2 config passes the permission gate;
#              install is idempotent and produces an executable hook.
#   negative — a group- or world-readable Tier-2 config (640 / 644 / 664)
#              BLOCKS the commit with the SEC-4 message and non-zero exit.
#   edge     — ABSENT Tier-2 still fails on the existence check (unchanged);
#              the permission gate never fires at 600; the check runs BEFORE
#              gitleaks so it needs no staged content.
#
# Fully headless [X2/T3 boundary]: every test installs the hook into a throwaway
# git repo under $BATS_TEST_TMPDIR and runs it with a scratch $HOME. The real
# ~/.aibender, the real .git/hooks, and the real keychain are NEVER touched. The
# Tier-2 fixture contains a FABRICATED value-free rule only — no private literal.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  INSTALLER="$REPO_ROOT/infra/scripts/install-hooks.sh"

  # A throwaway git repo so install-hooks.sh writes a hook we can exercise
  # without disturbing the real repo's .git/hooks/pre-commit.
  WORK="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$WORK"
  git -C "$WORK" init -q
  # The hook runs the Tier-1 scan BEFORE reaching the Tier-2 permission gate,
  # and fails closed if the committed Tier-1 config is missing. Seed the repo's
  # real, value-free .gitleaks.toml so Tier-1 passes on an empty index and the
  # flow reaches the SEC-4 Tier-2 assertion under test.
  cp "$REPO_ROOT/.gitleaks.toml" "$WORK/.gitleaks.toml"
  # install-hooks.sh keys off `git rev-parse --show-toplevel`, so run it FROM
  # the throwaway repo — never against the real one.
  ( cd "$WORK" && bash "$INSTALLER" >/dev/null )
  HOOK="$WORK/.git/hooks/pre-commit"

  # Scratch HOME holding the Tier-2 config the hook will look for.
  SCRATCH_HOME="$BATS_TEST_TMPDIR/home"
  TIER2_DIR="$SCRATCH_HOME/.aibender/private"
  TIER2="$TIER2_DIR/gitleaks-tier2.toml"
  mkdir -p "$TIER2_DIR"
}

# Write a minimal, value-free Tier-2 config (fabricated rule — no real literal).
seed_tier2() {
  cat > "$TIER2" <<'EOF'
title = "fabricated test tier-2 (value-free)"

[[rules]]
id = "fabricated-test-literal"
description = "a fabricated placeholder, never a real identifier"
regex = '''ZZZ-not-a-real-literal-ZZZ'''
EOF
  chmod "$1" "$TIER2"
}

# Run the generated hook from inside the throwaway repo with the scratch HOME.
run_hook() {
  run bash -c "cd '$WORK' && HOME='$SCRATCH_HOME' bash '$HOOK' 2>&1"
}

# --- install: positive ---------------------------------------------------------

@test "installer writes an executable pre-commit hook carrying the SEC-4 assertion" {
  [ -x "$HOOK" ]
  grep -q "GROUP/WORLD-READABLE" "$HOOK"
  grep -q "tier2_mode" "$HOOK"
}

@test "installer is idempotent (re-run leaves one aibender hook, no backup churn)" {
  ( cd "$WORK" && run_out="$(bash "$INSTALLER" 2>&1)"; echo "$run_out" )
  [ -x "$HOOK" ]
  # exactly one aibender-managed hook, no *.backup.* left behind by a re-run
  run bash -c "ls '$WORK/.git/hooks/' | grep -c 'pre-commit.backup' || true"
  [ "$output" = "0" ]
}

# --- Tier-2 permission gate: positive ------------------------------------------

@test "mode 600 Tier-2 config PASSES the permission gate" {
  seed_tier2 600
  run_hook
  # The permission gate must not fire at 600. (The hook may still exit non-zero
  # on the gitleaks scan of an empty index, but never with the SEC-4 message.)
  [[ "$output" != *"GROUP/WORLD-READABLE"* ]]
}

# --- Tier-2 permission gate: negative ------------------------------------------

@test "mode 644 (world-readable) Tier-2 config BLOCKS the commit" {
  seed_tier2 644
  run_hook
  [ "$status" -ne 0 ]
  [[ "$output" == *"COMMIT BLOCKED"* ]]
  [[ "$output" == *"GROUP/WORLD-READABLE (mode 644)"* ]]
  [[ "$output" == *"chmod 600"* ]]
}

@test "mode 640 (group-readable) Tier-2 config BLOCKS the commit" {
  seed_tier2 640
  run_hook
  [ "$status" -ne 0 ]
  [[ "$output" == *"GROUP/WORLD-READABLE (mode 640)"* ]]
}

@test "mode 664 (group+world-writable) Tier-2 config BLOCKS the commit" {
  seed_tier2 664
  run_hook
  [ "$status" -ne 0 ]
  [[ "$output" == *"GROUP/WORLD-READABLE (mode 664)"* ]]
}

# --- edge ----------------------------------------------------------------------

@test "ABSENT Tier-2 config still fails on the existence check (unchanged)" {
  # No seed_tier2 → the file does not exist. Existence check runs before the
  # permission gate, so we see ABSENT, not the mode message.
  [ ! -e "$TIER2" ]
  run_hook
  [ "$status" -ne 0 ]
  [[ "$output" == *"Tier-2 private scanner config is ABSENT"* ]]
  [[ "$output" != *"GROUP/WORLD-READABLE"* ]]
}

@test "the permission gate runs BEFORE gitleaks (no staged content required)" {
  # With a bad mode and an empty index, the hook must block on the SEC-4 gate,
  # not on any gitleaks output — proving the assertion is fail-closed and early.
  seed_tier2 644
  run_hook
  [ "$status" -ne 0 ]
  [[ "$output" == *"GROUP/WORLD-READABLE"* ]]
  # It stopped at the permission gate: no Tier-2 SCAN finding message.
  [[ "$output" != *"Tier-2 gitleaks scan found a PRIVATE LITERAL"* ]]
}
