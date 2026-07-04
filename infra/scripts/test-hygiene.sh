#!/usr/bin/env bash
# test-hygiene.sh — SI-1 unit tests (plan §9.2 matrix, server-side row 1).
#
#   positive: placeholders pass the gate; CI workflow syntax valid
#   negative: the three seeded leak classes each fail the gate
#             (CI equivalence holds by construction: gitleaks-action runs the
#              identical committed Tier-1 config over the same content)
#   edge:     Tier-2 config absent -> hook fails CLOSED with instructions;
#             allowlisted placeholder near a real-looking pattern still passes
#
# Pure shell (plan §9.2: server-side unit = shell-test). No repo mutation:
# seeds live in temp dirs outside the tree; the hook fail-closed test runs
# with a scratch HOME. Exit 0 iff every test passes.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TIER1="$REPO_ROOT/.gitleaks.toml"
TIER2="$HOME/.aibender/private/gitleaks-tier2.toml"
PASS=0; FAIL=0; SKIP=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
skip() { SKIP=$((SKIP+1)); echo "  SKIP  $1"; }

command -v gitleaks >/dev/null 2>&1 || { echo "FATAL: gitleaks not installed (brew install gitleaks)"; exit 1; }

scan_t1() { # $1 = dir to scan; returns gitleaks exit code
  gitleaks dir "$1" --config "$TIER1" --no-banner --redact >/dev/null 2>&1
}

TMP_BASE="$(mktemp -d "${TMPDIR:-/tmp}/hygiene-test.XXXXXX")"
trap 'rm -rf "$TMP_BASE"' EXIT

echo "== SI-1 hygiene gate tests (gitleaks $(gitleaks version)) =="

# ---------------------------------------------------------------- positive --
echo "-- positive --"

# P1: a placeholder-saturated file passes Tier 1
mkdir -p "$TMP_BASE/p1"
cat > "$TMP_BASE/p1/placeholders.txt" <<'EOF'
accounts: MAX_A, MAX_B, ENT
aws account: AWS_DEV_ACCOUNT_ID
profile: AWS_DEV_ACCOUNT_ID_AdministratorAccess
contact: MAX_A@example.com
author: 234062931+chris-dare-dev@users.noreply.github.com
trailer: noreply@anthropic.com
fixture: synth-user@fixtures.invalid
EOF
if scan_t1 "$TMP_BASE/p1"; then ok "P1 placeholder-saturated file passes Tier 1"; else bad "P1 placeholders flagged by Tier 1"; fi

# P2: the committed hygiene files themselves pass Tier 1
mkdir -p "$TMP_BASE/p2"
cp "$REPO_ROOT/.env.example" "$REPO_ROOT/SECURITY.md" "$TMP_BASE/p2/"
if scan_t1 "$TMP_BASE/p2"; then ok "P2 .env.example + SECURITY.md pass Tier 1"; else bad "P2 committed hygiene files flagged"; fi

# P3: CI workflow YAML is syntactically valid
yaml_check() {
  if command -v ruby >/dev/null 2>&1 && ruby -ryaml -e '' 2>/dev/null; then
    ruby -ryaml -e 'YAML.load_file(ARGV[0])' "$1" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' 2>/dev/null; then
    python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))' "$1" 2>/dev/null
  else
    return 2
  fi
}
P3_OK=1; P3_TOOL=1
for wf in "$REPO_ROOT"/.github/workflows/*.yml; do
  yaml_check "$wf"; rc=$?
  [ $rc -eq 2 ] && P3_TOOL=0 && break
  [ $rc -ne 0 ] && P3_OK=0 && echo "        invalid YAML: $wf"
done
if [ $P3_TOOL -eq 0 ]; then skip "P3 no YAML parser available (ruby/python3+yaml)";
elif [ $P3_OK -eq 1 ]; then ok "P3 all .github/workflows/*.yml parse as YAML"; else bad "P3 workflow YAML invalid"; fi

# ---------------------------------------------------------------- negative --
echo "-- negative (the three seeded leak classes) --"

neg_case() { # $1 label, $2 seed line, $3 expected rule id
  local d; d="$TMP_BASE/neg-$RANDOM"; mkdir -p "$d"
  printf '%s\n' "$2" > "$d/seed.txt"
  local out; out="$(gitleaks dir "$d" --config "$TIER1" --no-banner --redact -v 2>&1)"; local rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "$3"; then
    ok "$1 blocked by rule '$3'"
  else
    bad "$1 NOT blocked (rc=$rc, expected rule $3)"
  fi
  rm -rf "$d"
}
# All seed literals below are FABRICATED and assembled AT RUNTIME from split
# fragments, so this committed file itself contains no scannable leak pattern
# (the self-referential trap: a test file with an intact fake leak would be
# blocked by the very gate it tests). The 12-digit number matches nothing
# real — Tier 2 (not run here) is what knows the real one.
SEED_ID="4218""47390265"                          # 12 digits once joined
SEED_MAIL="blatantly.fake.leaker""@gm""ail.com"   # personal-provider address once joined
SEED_KEY="AKIA""W5Q7X2ND""J3RT6MVB"               # AKIA + 16 base32 chars once joined
neg_case "N1 12-digit number near AWS context" \
  "deploy target aws account: ${SEED_ID}" \
  "aws-account-id-in-context"
neg_case "N2 personal-provider email" \
  "on-call contact: ${SEED_MAIL}" \
  "personal-email-provider"
# base32 tail + high entropy required by gitleaks >= 8.30 (see runbook §4)
neg_case "N3 AWS access key ID (fabricated, base32)" \
  "export AWS_ACCESS_KEY_ID=${SEED_KEY}" \
  "aws-access-token"

# N4: every Tier-2 literal rule fires on its own (de-escaped) literal.
# Literals are read from the private config into a temp file OUTSIDE the
# tree and scanned with --redact; nothing is echoed.
if [ -f "$TIER2" ]; then
  d="$TMP_BASE/n4"; mkdir -p "$d"
  RULES=$(grep -c '^\[\[rules\]\]' "$TIER2")
  sed -n "s/^regex = '''\(.*\)'''$/\1/p" "$TIER2" | sed 's/\\//g; s/^(?i)@\?//' > "$d/literals.txt"
  out="$(gitleaks dir "$d" --config "$TIER2" --no-banner --redact -v 2>&1)"; rc=$?
  fired=$(printf '%s' "$out" | grep -c "RuleID:")
  if [ $rc -ne 0 ] && [ "$fired" -ge "$RULES" ]; then
    ok "N4 all $RULES Tier-2 literal rules fire ($fired findings)"
  else
    bad "N4 Tier-2 rules incomplete: $fired findings for $RULES rules (rc=$rc)"
  fi
  rm -rf "$d"
else
  skip "N4 Tier-2 config absent on this machine (edge E1 covers fail-closed)"
fi

# -------------------------------------------------------------------- edge --
echo "-- edge --"

# E1: Tier-2 config absent -> installed hook FAILS CLOSED with instructions.
# Run the hook with a scratch HOME so ~/.aibender/... is guaranteed absent.
HOOK="$REPO_ROOT/.git/hooks/pre-commit"
[ -x "$HOOK" ] || "$REPO_ROOT/infra/scripts/install-hooks.sh" >/dev/null
if [ -x "$HOOK" ]; then
  E1_HOME="$TMP_BASE/e1-home"; mkdir -p "$E1_HOME"
  out="$(cd "$REPO_ROOT" && HOME="$E1_HOME" bash "$HOOK" 2>&1)"; rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "Tier-2 private scanner config is ABSENT"; then
    ok "E1 hook fails CLOSED with setup instructions when Tier-2 is absent"
  else
    bad "E1 hook did not fail closed (rc=$rc)"
  fi
else
  bad "E1 pre-commit hook missing and installer failed"
fi

# E2: allowlisted placeholders adjacent to real-looking patterns still pass
mkdir -p "$TMP_BASE/e2"
cat > "$TMP_BASE/e2/edge.txt" <<'EOF'
aws sso login --profile AWS_DEV_ACCOUNT_ID_AdministratorAccess
arn:aws:iam::AWS_DEV_ACCOUNT_ID:role/telemetry-readonly
bedrock account MAX_A@example.com profile owner 234062931+chris-dare-dev@users.noreply.github.com
EOF
if scan_t1 "$TMP_BASE/e2"; then ok "E2 placeholders near real-looking AWS/email context pass"; else bad "E2 allowlisted placeholder false-positive"; fi

# E3: gitleaks missing -> hook fails closed (simulated via empty PATH probe)
if [ -x "$HOOK" ]; then
  out="$(cd "$REPO_ROOT" && PATH="/usr/bin:/bin" HOME="$TMP_BASE" bash "$HOOK" 2>&1)"; rc=$?
  if command -v gitleaks >/dev/null 2>&1 && ! PATH="/usr/bin:/bin" command -v gitleaks >/dev/null 2>&1; then
    if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "gitleaks is not installed"; then
      ok "E3 hook fails CLOSED when gitleaks is not on PATH"
    else
      bad "E3 hook did not fail closed without gitleaks (rc=$rc)"
    fi
  else
    skip "E3 cannot simulate a gitleaks-free PATH on this machine"
  fi
fi

echo "== results: $PASS passed, $FAIL failed, $SKIP skipped =="
[ $FAIL -eq 0 ]
