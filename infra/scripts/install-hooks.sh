#!/usr/bin/env bash
# install-hooks.sh — (re)install the-last-aibender git hooks idempotently.
# X2 / SI-1: wires the two-tier gitleaks pre-commit gate into .git/hooks/.
#
# Usage: infra/scripts/install-hooks.sh
# Safe to re-run at any time. If a foreign (non-aibender) pre-commit hook is
# present it is backed up to pre-commit.backup.<timestamp> before overwrite.

set -euo pipefail

MARKER="the-last-aibender two-tier gitleaks gate"
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks)"
# git rev-parse --git-path may return a relative path; anchor it.
case "$HOOKS_DIR" in
  /*) : ;;
  *) HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR" ;;
esac
HOOK="$HOOKS_DIR/pre-commit"

mkdir -p "$HOOKS_DIR"

if [ -f "$HOOK" ] && ! grep -q "$MARKER" "$HOOK"; then
  BACKUP="$HOOK.backup.$(date +%Y%m%d%H%M%S)"
  echo "install-hooks: existing non-aibender pre-commit hook found; backing up to $BACKUP"
  mv "$HOOK" "$BACKUP"
fi

cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# pre-commit — the-last-aibender two-tier gitleaks gate (X2 / SI-1)
# Managed by infra/scripts/install-hooks.sh — edits here will be overwritten.
#
# Tier 1: committed .gitleaks.toml (generic, value-free rules + gitleaks defaults)
# Tier 2: ~/.aibender/private/gitleaks-tier2.toml (exact private literals,
#         chmod 600, NEVER in the repo) — always run with --redact so the
#         hook's own output never echoes a literal into a terminal transcript.
#
# THIS HOOK FAILS CLOSED: missing gitleaks, a missing Tier-2 config, OR a
# Tier-2 config that is not mode 600 all block the commit. That is deliberate —
# agents are commit authors in this repo and hook-level scanning, not agent
# diligence, is the enforcement (X2 §4.4). The Tier-2 file holds exact private
# literals, so a group/world-readable copy is itself an exposure; the hook
# refuses to run it until it is locked down (SEC-4).

set -u

REPO_ROOT="$(git rev-parse --show-toplevel)"
TIER1_CONFIG="$REPO_ROOT/.gitleaks.toml"
TIER2_CONFIG="$HOME/.aibender/private/gitleaks-tier2.toml"

fail() {
  echo "" >&2
  echo "pre-commit: COMMIT BLOCKED — $1" >&2
  exit 1
}

command -v gitleaks >/dev/null 2>&1 || fail "gitleaks is not installed.
  Install it:            brew install gitleaks
  This gate fails closed: no commits in this repo without the scanner.
  (Setup runbook: docs/runbooks/hygiene.md)"

[ -f "$TIER1_CONFIG" ] || fail "Tier-1 config $TIER1_CONFIG is missing.
  Restore it from git history — committing without the Tier-1 gate is not allowed."

# ---- Tier 1: generic value-free rules + gitleaks defaults -------------------
# (gitleaks >= 8.19 replaced 'protect --staged' with 'git --pre-commit --staged')
# -v so the blocked author sees WHICH rule tripped; --redact keeps the secret out.
if ! gitleaks git --pre-commit --staged --redact --no-banner -v \
      --config "$TIER1_CONFIG" "$REPO_ROOT"; then
  fail "Tier-1 gitleaks scan found leaks in the staged changes.
  Fix or remove the flagged content. Placeholders (MAX_A/MAX_B/ENT/
  AWS_DEV_ACCOUNT_ID, *@example.com) are the only identities allowed in the
  tree. See docs/runbooks/hygiene.md and SECURITY.md."
fi

# ---- Tier 2: private exact literals — FAIL CLOSED when absent ---------------
if [ ! -f "$TIER2_CONFIG" ]; then
  fail "Tier-2 private scanner config is ABSENT: $TIER2_CONFIG
  This machine cannot commit to the-last-aibender until it exists.
  It holds the exact private identifier literals (never committed) that the
  generic Tier-1 rules cannot know. To create it:
    1. mkdir -p ~/.aibender/private && chmod 700 ~/.aibender ~/.aibender/private
    2. Author the file per the schema in docs/runbooks/hygiene.md
       (one [[rules]] block per private literal: work email, AWS account ID,
        personal emails).
    3. chmod 600 ~/.aibender/private/gitleaks-tier2.toml
  Do NOT copy the file's contents into the repo, an issue, or a transcript."
fi

# ---- Tier 2 permission assertion: FAIL CLOSED unless mode 600 (SEC-4) -------
# The Tier-2 config holds exact private literals; a group/world-readable copy
# (e.g. created under a permissive umask) is itself an exposure. Refuse to run
# it until it is locked to owner-only read/write. `stat` differs by platform:
# BSD/macOS is `-f %Lp`, GNU/Linux is `-c %a` — probe both; if neither works
# (no stat), fail closed rather than skip the check.
tier2_mode=""
if tier2_mode="$(stat -f '%Lp' "$TIER2_CONFIG" 2>/dev/null)"; then
  :
elif tier2_mode="$(stat -c '%a' "$TIER2_CONFIG" 2>/dev/null)"; then
  :
else
  tier2_mode=""
fi
if [ -z "$tier2_mode" ]; then
  fail "Cannot read the permission bits of the Tier-2 config: $TIER2_CONFIG
  'stat' produced no mode (neither BSD '-f %Lp' nor GNU '-c %a' worked).
  This gate fails closed rather than run a config whose permissions it cannot
  verify — the file holds exact private literals and must be chmod 600."
fi
if [ "$tier2_mode" != "600" ]; then
  fail "Tier-2 private scanner config is GROUP/WORLD-READABLE (mode $tier2_mode): $TIER2_CONFIG
  It holds exact private identifier literals and must be readable ONLY by you.
  Lock it down, then retry:
    chmod 600 $TIER2_CONFIG
  (Set 'umask 0077' before creating machine-local private files — see
   docs/runbooks/hygiene.md.)"
fi

if ! gitleaks git --pre-commit --staged --redact --no-banner -v \
      --config "$TIER2_CONFIG" "$REPO_ROOT"; then
  fail "Tier-2 gitleaks scan found a PRIVATE LITERAL in the staged changes.
  The finding above is redacted on purpose — do not paste the literal anywhere.
  Replace it with the matching placeholder (MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID
  or a noreply address). See SECURITY.md."
fi

exit 0
HOOK_EOF

chmod +x "$HOOK"
echo "install-hooks: installed $HOOK (the-last-aibender two-tier gitleaks gate)"
