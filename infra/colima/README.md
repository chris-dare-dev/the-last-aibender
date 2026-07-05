# infra/colima/ — Colima/k3s demotion & LM Studio guarantees (SI-5, [X3])

The [X3] verdict (PARTIAL) made the harness core **fully host-native**: LM
Studio reachability on `127.0.0.1` is guaranteed by construction, and
k3s-in-Colima is demoted to an **optional telemetry adjunct** — never a
dependency of session launch or LM Studio access. What remains for the VM is
discipline: version pins, a mandatory upgrade-gating probe, and owner-gated
right-sizing. Sources:
[x3-virtualization-colima-k3s](../../docs/research/findings/x3-virtualization-colima-k3s.md),
blueprint §9, plan §6/SI-5 + §9.2 SI-5 row.

| File | Purpose |
|---|---|
| `pins.env` | The **verified-good networking baseline**: colima 0.10.1 / lima 2.1.1 (+ k3s/macOS context), the stack on which the pod→host loopback gate was proven empirically. Updated ONLY as the final step of a green upgrade run (runbook). |
| `probe-pod-host-loopback.sh` | The [X3] gate probe: certifies that a consumer inside the VM (guest leg, and optionally a k3s pod leg) reaches a host service bound strictly to `127.0.0.1` via `host.lima.internal`. **Read-only by construction** — it never starts, stops, resizes, or deletes anything; VM down / target down / toolchain absent are DOWN-as-state (exit 3), a loopback regression is RED (exit 1). |
| `tests/` | shellcheck + headless bats: stub colima/limactl/kubectl with an invocation log (proves no lifecycle subcommand is ever attempted) + a real loopback fake server standing in for LM Studio. `bash infra/colima/tests/run.sh` |

## The rules encoded here

1. **The probe is a MANDATORY gate on every colima/lima upgrade** — the
   loopback-forwarding behavior is version-fragile (colima#698 class); the
   full procedure, including the owner-gated mutations this package never
   performs (right-size 8CPU/24GiB → ~4CPU/8–12GiB, deletion of the dormant
   x86_64 profile), lives in
   [docs/runbooks/colima.md](../../docs/runbooks/colima.md).
2. **Down is a first-class state.** The probe reports it and exits 3; it
   repairs nothing. LM Studio is never auto-started; the VM is never
   started/stopped (owner-gated — External System Write Policy).
3. **k3s is optional.** A missing/unreachable cluster SKIPs the pod leg and
   the guest leg can still certify GREEN; pass `--require-pod-leg` only when
   the adjunct is declared in service. The harness core never imports
   anything from `infra/` (standing architectural test, core-side).
4. **0.0.0.0 LM Studio rebind is strictly fallback** — documented in the
   runbook with its security preconditions, never configured from here.

## Live-host entry

`infra/ci/live-check.sh --check colima-probe` runs the probe read-only on
the real Mac and maps GREEN/DOWN/RED to PASS/SKIP(pending-owner)/FAIL.
