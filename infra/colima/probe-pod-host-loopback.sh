#!/usr/bin/env bash
# probe-pod-host-loopback.sh — SI-5 [X3] pod→host loopback probe.
#
# Re-proves the ONE fragile fact the [X3] verdict depends on: that a consumer
# inside the Colima VM (guest, and optionally a k3s pod) can reach a host
# service bound strictly to 127.0.0.1 via host.lima.internal — the exact
# empirical result recorded for colima 0.10.1 / lima 2.1.1 in
# docs/research/findings/x3-virtualization-colima-k3s.md §5. Upstream history
# (colima#698 NXDOMAIN-in-pods, colima#653) proves this can regress across
# versions, so this probe is the MANDATORY gate on every colima/lima upgrade
# (docs/runbooks/colima.md).
#
# READ-ONLY BY CONSTRUCTION — hard rules honored here:
#   * NEVER starts, stops, restarts, resizes, or deletes the VM or the k3s
#     cluster (those are owner-gated mutations). If the VM is down the probe
#     reports DOWN as a first-class state and exits 3 — it does not "fix" it.
#   * The host target service (default: LM Studio on 127.0.0.1:1234) is
#     probed, never launched. Target down → DOWN-as-state, never a FAIL.
#   * In-guest and in-pod commands are plain HTTP GETs (curl/wget) — no
#     writes, no package installs, no config changes.
#   * k3s is an OPTIONAL adjunct: an absent/unreachable cluster SKIPs the
#     pod leg and can still certify GREEN via the guest leg (k3s is never a
#     dependency of session launch or LM Studio access [X3]).
#
# Usage:
#   probe-pod-host-loopback.sh [--port N] [--path P] [--profile NAME]
#                              [--pins FILE] [--allow-drift]
#                              [--skip-pod-leg | --require-pod-leg]
#                              [--kube-context NAME] [--timeout N]
#
#   --port N            host target port (default 1234 — LM Studio)
#   --path P            GET path on the target (default /v1/models)
#   --profile NAME      colima profile (default: default)
#   --pins FILE         pins file (default: pins.env next to this script)
#   --allow-drift       report version drift as DRIFT instead of FAIL — for
#                       evaluating an upgrade BEFORE pins.env is updated
#   --skip-pod-leg      never attempt the k3s pod leg
#   --require-pod-leg   a skipped pod leg downgrades the result to DOWN
#                       (use when the k3s adjunct is in service)
#   --kube-context NAME kubectl context for the pod leg (default: colima)
#   --timeout N         per-request timeout seconds (default 5)
#
# Report lines (tab-separated): probe<TAB>LEG<TAB>STATUS<TAB>DETAIL
#   legs:     pins · vm · host-target · guest-loopback · pod-loopback
#   statuses: OK · DRIFT · DOWN · SKIP · FAIL
# Summary:  "RESULT: GREEN|DOWN|RED (...)"
# Exit:     0 GREEN (gate certified) · 1 RED (regression — do NOT accept the
#           upgrade) · 2 usage error · 3 DOWN (cannot certify: tool/VM/target
#           down — an honest state, not a failure of the stack)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=1234
GET_PATH="/v1/models"
PROFILE="default"
PINS_FILE="$SCRIPT_DIR/pins.env"
ALLOW_DRIFT=0
SKIP_POD_LEG=0
REQUIRE_POD_LEG=0
KUBE_CONTEXT="colima"
TIMEOUT=5

usage() {
  sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'probe: %s\n' "$*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) shift; PORT="${1:?--port needs a value}" ;;
    --path) shift; GET_PATH="${1:?--path needs a value}" ;;
    --profile) shift; PROFILE="${1:?--profile needs a value}" ;;
    --pins) shift; PINS_FILE="${1:?--pins needs a value}" ;;
    --allow-drift) ALLOW_DRIFT=1 ;;
    --skip-pod-leg) SKIP_POD_LEG=1 ;;
    --require-pod-leg) REQUIRE_POD_LEG=1 ;;
    --kube-context) shift; KUBE_CONTEXT="${1:?--kube-context needs a value}" ;;
    --timeout) shift; TIMEOUT="${1:?--timeout needs a value}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

case "$PORT" in ''|*[!0-9]*) die "--port must be an integer (got: $PORT)" ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) die "--timeout must be an integer (got: $TIMEOUT)" ;; esac
[ "$SKIP_POD_LEG" -eq 1 ] && [ "$REQUIRE_POD_LEG" -eq 1 ] \
  && die "--skip-pod-leg and --require-pod-leg are mutually exclusive"
[ -f "$PINS_FILE" ] || die "pins file not found: $PINS_FILE"
command -v curl >/dev/null 2>&1 || die "curl is required on the host"

# shellcheck source=infra/colima/pins.env
. "$PINS_FILE"
[ -n "${AIB_COLIMA_PIN:-}" ] && [ -n "${AIB_LIMA_PIN:-}" ] \
  || die "pins file must set AIB_COLIMA_PIN and AIB_LIMA_PIN: $PINS_FILE"

HOST_URL="http://127.0.0.1:$PORT$GET_PATH"
GUEST_URL="http://host.lima.internal:$PORT$GET_PATH"
# One fetch command string reused in guest and pod (sh -c): curl first, wget
# fallback — plain GETs only.
FETCH_CMD="curl -fsS --max-time $TIMEOUT '$GUEST_URL' >/dev/null 2>&1 || wget -qO- -T $TIMEOUT '$GUEST_URL' >/dev/null 2>&1"

RED=0
DOWN=0

leg() { # $1 = leg, $2 = status, $3 = detail
  printf 'probe\t%s\t%s\t%s\n' "$1" "$2" "$3"
  case "$2" in
    FAIL) RED=1 ;;
    DOWN) DOWN=1 ;;
  esac
}

finish() {
  if [ "$RED" -eq 1 ]; then
    printf 'RESULT: RED (pod→host loopback gate NOT satisfied — do not accept this colima/lima state; docs/runbooks/colima.md fallback ladder)\n'
    exit 1
  fi
  if [ "$DOWN" -eq 1 ]; then
    printf 'RESULT: DOWN (cannot certify — a prerequisite is down; nothing was started or mutated by this probe)\n'
    exit 3
  fi
  printf 'RESULT: GREEN (host.lima.internal → 127.0.0.1:%s certified on this stack)\n' "$PORT"
  exit 0
}

# ---- leg 1: version pins ----------------------------------------------------

if ! command -v colima >/dev/null 2>&1 || ! command -v limactl >/dev/null 2>&1; then
  leg pins DOWN "colima/limactl not installed on this host — install the PINNED versions (pins.env: colima $AIB_COLIMA_PIN / lima $AIB_LIMA_PIN)"
  leg vm SKIP "not probed (toolchain absent)"
  leg host-target SKIP "not probed"
  leg guest-loopback SKIP "not probed"
  leg pod-loopback SKIP "not probed"
  finish
fi

COLIMA_INSTALLED="$(colima version 2>/dev/null | awk '/^colima version/ {print $3; exit}' || true)"
LIMA_INSTALLED="$(limactl --version 2>/dev/null | awk '/limactl/ {print $3; exit}' || true)"

if [ "$COLIMA_INSTALLED" = "$AIB_COLIMA_PIN" ] && [ "$LIMA_INSTALLED" = "$AIB_LIMA_PIN" ]; then
  leg pins OK "colima $COLIMA_INSTALLED / lima $LIMA_INSTALLED match pins.env (verified-good baseline, x3 findings §5)"
elif [ "$ALLOW_DRIFT" -eq 1 ]; then
  leg pins DRIFT "installed colima ${COLIMA_INSTALLED:-unknown} / lima ${LIMA_INSTALLED:-unknown} vs pins $AIB_COLIMA_PIN / $AIB_LIMA_PIN — drift allowed for upgrade evaluation; update pins.env ONLY with a GREEN result (docs/runbooks/colima.md)"
else
  leg pins FAIL "installed colima ${COLIMA_INSTALLED:-unknown} / lima ${LIMA_INSTALLED:-unknown} vs pins $AIB_COLIMA_PIN / $AIB_LIMA_PIN — unapproved drift; re-run with --allow-drift only as part of the runbook upgrade procedure (docs/runbooks/colima.md)"
fi

# ---- leg 2: VM state (read-only; NEVER started from here) --------------------

if colima status --profile "$PROFILE" >/dev/null 2>&1; then
  leg vm OK "profile '$PROFILE' running (read-only status check)"
else
  leg vm DOWN "profile '$PROFILE' not running — DOWN is a first-class state; starting the VM is owner-gated and NEVER done by this probe (docs/runbooks/colima.md)"
  leg host-target SKIP "not probed (VM down)"
  leg guest-loopback SKIP "not probed (VM down)"
  leg pod-loopback SKIP "not probed (VM down)"
  finish
fi

# ---- leg 3: host-side target (proves the service, isolates the fault) --------

if curl -fsS --max-time "$TIMEOUT" "$HOST_URL" >/dev/null 2>&1; then
  leg host-target OK "$HOST_URL reachable host-side"
else
  leg host-target DOWN "$HOST_URL down host-side — target service (LM Studio?) is never auto-started; start it (owner) and re-run to certify the forwarding path"
  leg guest-loopback SKIP "not probed (target down host-side — a guest failure would be unattributable)"
  leg pod-loopback SKIP "not probed (target down host-side)"
  finish
fi

# ---- leg 4: guest → host loopback (THE gate) ---------------------------------

if colima ssh --profile "$PROFILE" -- sh -c "$FETCH_CMD" >/dev/null 2>&1; then
  leg guest-loopback OK "guest reached $GUEST_URL (host 127.0.0.1-bound service via usernet gateway)"
else
  leg guest-loopback FAIL "guest could NOT reach $GUEST_URL while the target is up host-side — the loopback-forwarding regression the pin guards against (colima#698 class); do not accept this version"
fi

# ---- leg 5: pod → host loopback (optional k3s adjunct leg) --------------------

# With --require-pod-leg the adjunct is declared in-service, so a leg that
# cannot run cannot certify the gate: SKIP degrades honestly to DOWN.
pod_leg() { # $1 = status, $2 = detail
  local status="$1" detail="$2"
  if [ "$status" = "SKIP" ] && [ "$REQUIRE_POD_LEG" -eq 1 ]; then
    status="DOWN"
    detail="$detail — required by --require-pod-leg, cannot certify without it"
  fi
  leg pod-loopback "$status" "$detail"
}

if [ "$SKIP_POD_LEG" -eq 1 ]; then
  pod_leg SKIP "skipped by flag (--skip-pod-leg)"
elif ! command -v kubectl >/dev/null 2>&1; then
  pod_leg SKIP "kubectl not installed — adjunct leg unavailable (k3s is optional [X3])"
elif ! kubectl --context "$KUBE_CONTEXT" get pods -A --field-selector=status.phase=Running --no-headers >/dev/null 2>&1; then
  pod_leg SKIP "kubectl context '$KUBE_CONTEXT' unreachable — adjunct cluster down/absent is a first-class state, never repaired from here"
else
  POD_LINE="$(kubectl --context "$KUBE_CONTEXT" get pods -A --field-selector=status.phase=Running --no-headers 2>/dev/null | head -n 1)"
  if [ -z "$POD_LINE" ]; then
    pod_leg SKIP "no Running pod to exec into (probe never creates pods)"
  else
    POD_NS="$(printf '%s\n' "$POD_LINE" | awk '{print $1}')"
    POD_NAME="$(printf '%s\n' "$POD_LINE" | awk '{print $2}')"
    if ! kubectl --context "$KUBE_CONTEXT" exec -n "$POD_NS" "$POD_NAME" -- \
        sh -c 'command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1' >/dev/null 2>&1; then
      pod_leg SKIP "pod $POD_NS/$POD_NAME has neither curl nor wget — no tooling to probe with (nothing is installed into pods)"
    elif kubectl --context "$KUBE_CONTEXT" exec -n "$POD_NS" "$POD_NAME" -- \
        sh -c "$FETCH_CMD" >/dev/null 2>&1; then
      pod_leg OK "pod $POD_NS/$POD_NAME reached $GUEST_URL (CoreDNS forward + usernet gateway intact)"
    else
      pod_leg FAIL "pod $POD_NS/$POD_NAME could NOT reach $GUEST_URL while the guest leg is green — pod-DNS/forward regression (colima#698 class); do not accept this version"
    fi
  fi
fi

finish
