#!/usr/bin/env bats
# probe.bats — SI-5 [X3] pod→host loopback probe tests.
#
# Plan §9.2 SI-5 row:
#   positive — probe green on pinned versions (headless edition: pinned stub
#              versions + a REAL loopback fake server standing in for the
#              127.0.0.1-bound host service)
#   negative — version drift vs pins.env fails closed; a guest/pod leg that
#              cannot reach the fake server while it is up host-side is a
#              RED regression; static hygiene: the probe can never start,
#              stop, resize, or delete the VM/cluster (source-level pin +
#              invocation-log proof)
#   edge     — VM down / target down / toolchain absent are DOWN-as-state
#              (exit 3), never FAIL; the k3s pod leg is optional (SKIP keeps
#              GREEN — non-dependency [X3]) unless --require-pod-leg
#
# Fully headless: colima/limactl/kubectl are PATH stubs that log every
# invocation; the only real network activity is loopback GETs against a
# python3 fake server owned by this suite. The real colima VM, the real
# cluster, and LM Studio are NEVER touched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  COLIMA_DIR="$REPO_ROOT/infra/colima"
  PROBE="$COLIMA_DIR/probe-pod-host-loopback.sh"
  PINS="$COLIMA_DIR/pins.env"

  SYS_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  STUBS="$BATS_TEST_TMPDIR/stubs"          # colima + limactl
  KSTUBS="$BATS_TEST_TMPDIR/kstubs"        # kubectl (separate so tests can drop it)
  mkdir -p "$STUBS" "$KSTUBS"
  export STUB_LOG="$BATS_TEST_TMPDIR/invocations.log"
  : > "$STUB_LOG"

  cat > "$STUBS/colima" <<'STUB'
#!/usr/bin/env bash
printf 'colima %s\n' "$*" >> "${STUB_LOG:-/dev/null}"
case "$1" in
  version)
    printf 'colima version %s\n' "${STUB_COLIMA_VERSION:-0.10.1}"
    printf 'git commit: 0000000000000000000000000000000000000000\n'
    ;;
  status)
    exit "${STUB_COLIMA_STATUS_EXIT:-0}"
    ;;
  ssh)
    if [ "${STUB_SSH_MODE:-ok}" != "ok" ]; then exit 255; fi
    for last; do :; done
    exec sh -c "${last//host.lima.internal/127.0.0.1}"
    ;;
  *)
    echo "stub colima: unexpected subcommand: $*" >&2
    exit 64
    ;;
esac
STUB
  chmod +x "$STUBS/colima"

  cat > "$STUBS/limactl" <<'STUB'
#!/usr/bin/env bash
printf 'limactl %s\n' "$*" >> "${STUB_LOG:-/dev/null}"
case "$1" in
  --version) printf 'limactl version %s\n' "${STUB_LIMA_VERSION:-2.1.1}" ;;
  *) echo "stub limactl: unexpected: $*" >&2; exit 64 ;;
esac
STUB
  chmod +x "$STUBS/limactl"

  cat > "$KSTUBS/kubectl" <<'STUB'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >> "${STUB_LOG:-/dev/null}"
mode="${STUB_KUBECTL_MODE:-ok}"
case "$*" in
  *"get pods"*)
    [ "$mode" = "unreachable" ] && exit 1
    if [ "$mode" != "nopods" ]; then
      printf 'default\tfake-pod-0\t1/1\tRunning\t0\t1d\n'
    fi
    ;;
  *exec*)
    for last; do :; done
    case "$last" in
      *"command -v"*)
        [ "$mode" = "notools" ] && exit 1
        exit 0
        ;;
      *)
        [ "$mode" = "refuse-fetch" ] && exit 1
        exec sh -c "${last//host.lima.internal/127.0.0.1}"
        ;;
    esac
    ;;
  *) echo "stub kubectl: unexpected: $*" >&2; exit 64 ;;
esac
STUB
  chmod +x "$KSTUBS/kubectl"

  FAKE_PID=""
  FAKE_PORT=""
}

teardown() {
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
}

# A REAL 127.0.0.1-bound HTTP server — the LM Studio stand-in the probe's
# fetch legs actually hit (through the stubs' host.lima.internal rewrite).
start_fake_server() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required for the fake server"
  local tries=0 waited
  while [ "$tries" -lt 5 ]; do
    FAKE_PORT=$(( 20000 + RANDOM % 20000 ))
    python3 - "$FAKE_PORT" <<'PY' &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"object":"list","data":[]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", int(sys.argv[1])), H) as srv:
    srv.serve_forever()
PY
    FAKE_PID=$!
    waited=0
    while [ "$waited" -lt 25 ]; do
      if curl -fsS --max-time 1 "http://127.0.0.1:$FAKE_PORT/v1/models" >/dev/null 2>&1; then
        return 0
      fi
      kill -0 "$FAKE_PID" 2>/dev/null || break
      sleep 0.2
      waited=$((waited + 1))
    done
    kill "$FAKE_PID" 2>/dev/null || true
    FAKE_PID=""
    tries=$((tries + 1))
  done
  skip "could not bind a loopback fake server"
}

run_probe() { # extra args forwarded
  PATH="$STUBS:$KSTUBS:$SYS_PATH" run bash "$PROBE" "$@"
}

# --- positive ------------------------------------------------------------------

@test "green path: pinned versions + running VM + reachable target certify GREEN (exit 0)" {
  start_fake_server
  run_probe --port "$FAKE_PORT"
  [ "$status" -eq 0 ]
  grep -q $'^probe\tpins\tOK\t' <<<"$output"
  grep -q $'^probe\tvm\tOK\t' <<<"$output"
  grep -q $'^probe\thost-target\tOK\t' <<<"$output"
  grep -q $'^probe\tguest-loopback\tOK\t' <<<"$output"
  grep -q $'^probe\tpod-loopback\tOK\t' <<<"$output"
  grep -q '^RESULT: GREEN' <<<"$output"
  # invocation-log proof: read-only subcommands ONLY
  ! grep -Eq 'colima (start|stop|delete|restart|kubernetes|template)' "$STUB_LOG"
  ! grep -Eq 'limactl (start|stop|delete|edit|factory-reset)' "$STUB_LOG"
  grep -q '^colima version' "$STUB_LOG"
  grep -q '^colima status' "$STUB_LOG"
  grep -q '^colima ssh' "$STUB_LOG"
}

@test "report lines are 5 tab-separated legs + one RESULT summary" {
  start_fake_server
  run_probe --port "$FAKE_PORT"
  [ "$status" -eq 0 ]
  [ "$(grep -c $'^probe\t' <<<"$output")" -eq 5 ]
  [ "$(grep -c '^RESULT: ' <<<"$output")" -eq 1 ]
}

@test "custom --pins file is honored" {
  start_fake_server
  alt="$BATS_TEST_TMPDIR/alt-pins.env"
  printf 'AIB_COLIMA_PIN="9.9.9"\nAIB_LIMA_PIN="8.8.8"\n' > "$alt"
  export STUB_COLIMA_VERSION="9.9.9" STUB_LIMA_VERSION="8.8.8"
  run_probe --port "$FAKE_PORT" --pins "$alt"
  [ "$status" -eq 0 ]
  grep -q $'^probe\tpins\tOK\t' <<<"$output"
}

# --- negative: drift + regression are RED --------------------------------------

@test "version drift vs pins.env is RED without --allow-drift (fail closed)" {
  start_fake_server
  export STUB_COLIMA_VERSION="0.11.0"
  run_probe --port "$FAKE_PORT"
  [ "$status" -eq 1 ]
  grep -q $'^probe\tpins\tFAIL\t' <<<"$output"
  grep -q 'unapproved drift' <<<"$output"
  grep -q '^RESULT: RED' <<<"$output"
}

@test "--allow-drift reports DRIFT for upgrade evaluation and can still certify GREEN" {
  start_fake_server
  export STUB_COLIMA_VERSION="0.11.0" STUB_LIMA_VERSION="2.2.0"
  run_probe --port "$FAKE_PORT" --allow-drift
  [ "$status" -eq 0 ]
  grep -q $'^probe\tpins\tDRIFT\t' <<<"$output"
  grep -q 'update pins.env ONLY with a GREEN result' <<<"$output"
  grep -q '^RESULT: GREEN' <<<"$output"
}

@test "guest leg refused while the target is up host-side is THE regression: RED, exit 1" {
  start_fake_server
  export STUB_SSH_MODE="refuse"
  run_probe --port "$FAKE_PORT"
  [ "$status" -eq 1 ]
  grep -q $'^probe\thost-target\tOK\t' <<<"$output"
  grep -q $'^probe\tguest-loopback\tFAIL\t' <<<"$output"
  grep -q 'colima#698' <<<"$output"
  grep -q '^RESULT: RED' <<<"$output"
}

@test "pod fetch refused while the guest leg is green is RED (pod-DNS regression class)" {
  start_fake_server
  export STUB_KUBECTL_MODE="refuse-fetch"
  run_probe --port "$FAKE_PORT"
  [ "$status" -eq 1 ]
  grep -q $'^probe\tguest-loopback\tOK\t' <<<"$output"
  grep -q $'^probe\tpod-loopback\tFAIL\t' <<<"$output"
  grep -q '^RESULT: RED' <<<"$output"
}

@test "static hygiene: the probe source can never mutate the VM, the cluster, or LM Studio" {
  code="$(grep -vE '^[[:space:]]*#' "$PROBE")"
  ! grep -Eq 'colima[[:space:]]+(start|stop|delete|restart|kubernetes|template|prune)' <<<"$code"
  ! grep -Eq 'limactl[[:space:]]+(start|stop|delete|edit|factory-reset)' <<<"$code"
  ! grep -Eq 'lms[[:space:]]+server[[:space:]]+start' <<<"$code"
  ! grep -Eq 'curl[^|]*-X' <<<"$code"          # plain GETs only
  ! grep -Eq 'kubectl[^|]*(apply|create|delete|patch|scale|edit)' <<<"$code"
  ! grep -Fq -- '--memory' <<<"$code"          # right-size is owner-gated, runbook-only
}

# --- usage errors ----------------------------------------------------------------

@test "unknown flag, bad --port, missing pins, and conflicting pod-leg flags are usage errors (exit 2)" {
  run bash "$PROBE" --frobnicate
  [ "$status" -eq 2 ]
  run bash "$PROBE" --port notanumber
  [ "$status" -eq 2 ]
  run bash "$PROBE" --pins /nonexistent/pins.env
  [ "$status" -eq 2 ]
  run bash "$PROBE" --skip-pod-leg --require-pod-leg
  [ "$status" -eq 2 ]
}

# --- edge: DOWN is a first-class state, never FAIL --------------------------------

@test "toolchain absent: DOWN (exit 3) with the install pointer, remaining legs SKIP" {
  PATH="$SYS_PATH" run bash "$PROBE"
  [ "$status" -eq 3 ]
  grep -q $'^probe\tpins\tDOWN\t' <<<"$output"
  grep -q 'not installed' <<<"$output"
  [ "$(grep -c $'\tSKIP\t' <<<"$output")" -eq 4 ]
  grep -q '^RESULT: DOWN' <<<"$output"
}

@test "VM down: DOWN-as-state (exit 3), later legs SKIP, and the probe provably starts NOTHING" {
  export STUB_COLIMA_STATUS_EXIT=1
  run_probe
  [ "$status" -eq 3 ]
  grep -q $'^probe\tvm\tDOWN\t' <<<"$output"
  grep -q 'NEVER done by this probe' <<<"$output"
  grep -q $'^probe\tguest-loopback\tSKIP\t' <<<"$output"
  grep -q '^RESULT: DOWN' <<<"$output"
  # the invocation log proves no lifecycle subcommand was ever attempted
  ! grep -Eq 'colima (start|stop|delete|restart)' "$STUB_LOG"
  ! grep -q 'colima ssh' "$STUB_LOG"
}

@test "host target down: DOWN-as-state (exit 3) — the service is never auto-started" {
  # No fake server: 127.0.0.1:<unused port> refuses.
  run_probe --port 1 --timeout 1
  [ "$status" -eq 3 ]
  grep -q $'^probe\tvm\tOK\t' <<<"$output"
  grep -q $'^probe\thost-target\tDOWN\t' <<<"$output"
  grep -q 'never auto-started' <<<"$output"
  grep -q $'^probe\tguest-loopback\tSKIP\t' <<<"$output"
  grep -q '^RESULT: DOWN' <<<"$output"
}

@test "pod leg is optional: kubectl absent SKIPs the leg and GREEN still certifies ([X3] non-dependency)" {
  start_fake_server
  PATH="$STUBS:$SYS_PATH" run bash "$PROBE" --port "$FAKE_PORT"
  [ "$status" -eq 0 ]
  grep -q $'^probe\tpod-loopback\tSKIP\t' <<<"$output"
  grep -q 'k3s is optional' <<<"$output"
  grep -q '^RESULT: GREEN' <<<"$output"
}

@test "cluster unreachable / no running pods / no in-pod tooling all SKIP the pod leg, still GREEN" {
  start_fake_server
  for mode in unreachable nopods notools; do
    export STUB_KUBECTL_MODE="$mode"
    run_probe --port "$FAKE_PORT"
    [ "$status" -eq 0 ]
    grep -q $'^probe\tpod-loopback\tSKIP\t' <<<"$output"
    grep -q '^RESULT: GREEN' <<<"$output"
  done
}

@test "--require-pod-leg degrades a skipped pod leg to DOWN (exit 3) — an in-service adjunct must be proven" {
  start_fake_server
  export STUB_KUBECTL_MODE="unreachable"
  run_probe --port "$FAKE_PORT" --require-pod-leg
  [ "$status" -eq 3 ]
  grep -q $'^probe\tpod-loopback\tDOWN\t' <<<"$output"
  grep -q -- '--require-pod-leg' <<<"$output"
  grep -q '^RESULT: DOWN' <<<"$output"
}

@test "--skip-pod-leg never invokes kubectl" {
  start_fake_server
  run_probe --port "$FAKE_PORT" --skip-pod-leg
  [ "$status" -eq 0 ]
  grep -q $'^probe\tpod-loopback\tSKIP\t' <<<"$output"
  ! grep -q '^kubectl' "$STUB_LOG"
}

# --- pins.env is the recorded baseline ---------------------------------------------

@test "pins.env pins the x3 findings verified-good baseline (colima 0.10.1 / lima 2.1.1)" {
  grep -q '^AIB_COLIMA_PIN="0.10.1"$' "$PINS"
  grep -q '^AIB_LIMA_PIN="2.1.1"$' "$PINS"
  grep -q '^AIB_K3S_BASELINE="v1.33.4+k3s1"$' "$PINS"
  # the read-only re-verification record is present
  grep -q '2026-07-04' "$PINS"
}
