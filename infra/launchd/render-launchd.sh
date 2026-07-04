#!/usr/bin/env bash
# render-launchd.sh — render the SI-3 LaunchAgent plist templates (SI-3, plan §6).
#
# Renders infra/launchd/templates/*.plist.template with concrete machine-local
# values into $AIBENDER_HOME/launchd/ (or --out-dir), lints the result, and
# PRINTS the owner-run launchctl commands. This script NEVER executes
# launchctl and never touches ~/Library/LaunchAgents — loading an agent is a
# live machine mutation and is T3, owner-run only (docs/runbooks/launchd.md).
#
# Agents:
#   broker  — aibender-core broker, Aqua gui-domain (v1-READY, NOT FLIPPED).
#             Deliberately carries NO LimitLoadToSessionType key (default =
#             Aqua). Blueprint §2; session-substrate-tiebreak findings.
#   lms     — LM Studio server via `lms server start`.
#   broker-background-expected-fail
#           — the documented EXPECTED-FAILURE Background/user-domain variant
#             (plan §9.2 SI-3 negative row). Refused without
#             --acknowledge-expected-failure. Never run a broker with it.
#
# [X2]: templates and rendered output contain machine-local paths only —
# no identities, no tokens. The expected-failure probe command targets a
# harness-owned DUMMY keychain item only; this script itself never invokes
# security(1) or launchctl(1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/accounts/lib.sh
. "$SCRIPT_DIR/../scripts/accounts/lib.sh"

TEMPLATES_DIR="$SCRIPT_DIR/templates"

usage() {
  cat <<'EOF'
usage: render-launchd.sh --agent <broker|lms|broker-background-expected-fail>
                         [--home DIR] [--out-dir DIR] [--dry-run]
                         [--node-bin PATH] [--broker-entry PATH] [--lms-bin PATH]
                         [--probe-cmd CMD] [--acknowledge-expected-failure]

Renders the requested LaunchAgent plist template with machine-local values,
lints it, and prints the OWNER-RUN launchctl bootstrap commands. Never
executes launchctl itself (T3 boundary — docs/runbooks/launchd.md).
EOF
}

AGENT=""
HOME_OVERRIDE=""
OUT_DIR=""
DRY_RUN=0
NODE_BIN=""
BROKER_ENTRY=""
LMS_BIN=""
PROBE_CMD=""
ACK_EXPECTED_FAIL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:?--agent needs a value}"; shift 2 ;;
    --home) HOME_OVERRIDE="${2:?--home needs a value}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?--out-dir needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --node-bin) NODE_BIN="${2:?--node-bin needs a value}"; shift 2 ;;
    --broker-entry) BROKER_ENTRY="${2:?--broker-entry needs a value}"; shift 2 ;;
    --lms-bin) LMS_BIN="${2:?--lms-bin needs a value}"; shift 2 ;;
    --probe-cmd) PROBE_CMD="${2:?--probe-cmd needs a value}"; shift 2 ;;
    --acknowledge-expected-failure) ACK_EXPECTED_FAIL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; aib_die "unknown argument: $1" ;;
  esac
done

[ -n "$AGENT" ] || { usage >&2; aib_die "--agent is required"; }

AIB_HOME="$(aib_home_resolve "$HOME_OVERRIDE")"
[ -n "$OUT_DIR" ] || OUT_DIR="$AIB_HOME/launchd"

case "$AGENT" in
  broker)
    TEMPLATE="$TEMPLATES_DIR/com.aibender.broker.plist.template"
    TARGET_NAME="com.aibender.broker.plist"
    ;;
  lms)
    TEMPLATE="$TEMPLATES_DIR/com.aibender.lms.plist.template"
    TARGET_NAME="com.aibender.lms.plist"
    ;;
  broker-background-expected-fail)
    TEMPLATE="$TEMPLATES_DIR/com.aibender.broker.background-expected-fail.plist.template"
    TARGET_NAME="com.aibender.broker.background-expected-fail.plist"
    if [ "$ACK_EXPECTED_FAIL" -ne 1 ]; then
      aib_die "REFUSED: '$AGENT' is the documented EXPECTED-FAILURE Background/user-domain probe variant — a broker run under it silently loses keychain access for all accounts (errSecInteractionNotAllowed, exit-36 class). Pass --acknowledge-expected-failure ONLY to render the T3 probe (docs/runbooks/launchd.md)."
    fi
    ;;
  *)
    aib_die "unknown --agent '$AGENT' (broker|lms|broker-background-expected-fail)"
    ;;
esac

[ -f "$TEMPLATE" ] || aib_die "template not found: $TEMPLATE"

# ---- token values -----------------------------------------------------------

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || NODE_BIN="/usr/local/bin/node"
fi
[ -z "$BROKER_ENTRY" ] && BROKER_ENTRY="$AIB_HOME/bin/aibender-core.mjs"
if [ -z "$LMS_BIN" ]; then
  LMS_BIN="$(command -v lms || true)"
  [ -n "$LMS_BIN" ] || LMS_BIN="$HOME/.lmstudio/bin/lms"
fi
# The expected-failure probe touches ONLY a harness-owned dummy item — never a
# real credentials item [X2]. -w here is the ACL-gated value-read call class
# the experiment must exercise; against the dummy item it is expected to exit
# 36 (errSecInteractionNotAllowed) in the Background session.
if [ -z "$PROBE_CMD" ]; then
  # shellcheck disable=SC2016  # expansion happens at probe RUNTIME inside launchd, not here
  PROBE_CMD='echo "managername=$(launchctl managername)"; security find-generic-password -s aibender-probe-dummy >/dev/null 2>&1; echo "dummy-metadata-exit=$?"; security find-generic-password -s aibender-probe-dummy -w >/dev/null 2>&1; echo "dummy-value-exit=$? (EXPECTED 36 in Background)"'
fi

for v in "$AIB_HOME" "$NODE_BIN" "$BROKER_ENTRY" "$LMS_BIN"; do
  case "$v" in
    *$'\n'*) aib_die "token values must not contain newlines: $v" ;;
  esac
done

# Existence is advisory only — the broker plist is v1-ready but NOT installed,
# so its entrypoint may legitimately not exist yet.
[ -x "$NODE_BIN" ] || aib_warn "node binary not found/executable at $NODE_BIN (render proceeds; fix before bootstrap)"
[ "$AGENT" != "lms" ] || [ -x "$LMS_BIN" ] || aib_warn "lms binary not found/executable at $LMS_BIN (render proceeds; fix before bootstrap)"

# ---- render (pure-bash substitution — safe for &, |, / in paths) -------------

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

render() {
  local content
  content="$(cat "$TEMPLATE")"
  content="${content//'{{AIBENDER_HOME}}'/$(xml_escape "$AIB_HOME")}"
  content="${content//'{{NODE_BIN}}'/$(xml_escape "$NODE_BIN")}"
  content="${content//'{{BROKER_ENTRY}}'/$(xml_escape "$BROKER_ENTRY")}"
  content="${content//'{{LMS_BIN}}'/$(xml_escape "$LMS_BIN")}"
  content="${content//'{{PROBE_CMD}}'/$(xml_escape "$PROBE_CMD")}"
  printf '%s\n' "$content"
}

RENDERED="$(render)"
case "$RENDERED" in
  *'{{'*) aib_die "internal error: unsubstituted token remains in rendered plist" ;;
esac

# ---- lint --------------------------------------------------------------------

lint_plist() {
  # $1 = file. plutil on macOS; python3 plistlib elsewhere (Linux CI).
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint -s "$1" >/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$1"
  else
    aib_warn "neither plutil nor python3 available — plist lint skipped"
  fi
}

TARGET="$OUT_DIR/$TARGET_NAME"

if [ "$DRY_RUN" -eq 1 ]; then
  tmp="$(mktemp)"
  printf '%s' "$RENDERED" > "$tmp"
  lint_plist "$tmp"
  rm -f "$tmp"
  printf 'render\t%s\t%s\tDRY-RUN (lint OK, nothing written)\n' "$AGENT" "$TARGET"
else
  mkdir -p "$OUT_DIR"
  chmod 700 "$OUT_DIR" 2>/dev/null || true
  tmp="$TARGET.$$.tmp"
  printf '%s' "$RENDERED" > "$tmp"
  if ! lint_plist "$tmp"; then
    rm -f "$tmp"
    aib_die "rendered plist failed lint: $TARGET"
  fi
  if [ -f "$TARGET" ] && cmp -s "$tmp" "$TARGET"; then
    rm -f "$tmp"
    printf 'render\t%s\t%s\tUNCHANGED\n' "$AGENT" "$TARGET"
  else
    chmod 644 "$tmp"
    mv -f "$tmp" "$TARGET"
    printf 'render\t%s\t%s\tRENDERED\n' "$AGENT" "$TARGET"
  fi
fi

# ---- owner-run next steps (printed, NEVER executed here — T3) -----------------

if [ "$AGENT" = "broker-background-expected-fail" ]; then
  cat <<EOF

EXPECTED-FAILURE PROBE (T3, owner-run — docs/runbooks/launchd.md):
  This agent is bootstrapped into the user/ (Background) domain ON PURPOSE
  to observe the keychain value-read failure. It must NEVER run the broker.
    launchctl bootstrap user/\$UID "$TARGET"
    # inspect $AIB_HOME/logs/background-expected-fail.out.log
    # EXPECTED: dummy-value-exit=36 (errSecInteractionNotAllowed)
    launchctl bootout user/\$UID/com.aibender.broker.background-expected-fail
  A probe that SUCCEEDS reading the value here invalidates the Aqua ruling —
  stop and re-verify before trusting gui-domain keychain access.
EOF
else
  cat <<EOF

Owner-run bootstrap (T3 — NOT executed by this script; docs/runbooks/launchd.md):
    launchctl bootstrap gui/\$UID "$TARGET"
    launchctl print gui/\$UID/${TARGET_NAME%.plist} | head -20
  Unload:
    launchctl bootout gui/\$UID/${TARGET_NAME%.plist}
EOF
fi
