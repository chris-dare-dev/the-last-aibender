# Runbook — Colima/k3s adjunct: pins, the loopback probe gate, owner-gated right-sizing

**Status:** SI-5 ungated slice landed (pins + probe + this runbook); every VM
mutation below is **owner-gated (T3, VERBAL OK required)** and has never been
run by an agent ·
**Scripts:** `infra/colima/probe-pod-host-loopback.sh` (+
`infra/colima/pins.env`, `infra/colima/tests/run.sh`)
**Sources of record:**
[x3-virtualization-colima-k3s](../research/findings/x3-virtualization-colima-k3s.md)
(the empirical loopback proof and resource math), blueprint §9, plan §6/SI-5
+ §7 [X3] row + §9.2 SI-5 row.

## Standing posture ([X3], decided — do not re-litigate)

- **Harness core is host-native.** Claude sessions, LM Studio, OpenCode, the
  broker and the frontend never run in, or depend on, the VM. `core/`
  imports nothing from `infra/` (standing architectural test in
  `core/src/adapters/opencode/serve.spec.ts` — "adapters [X3] architectural
  guard").
- **k3s-in-Colima is an optional telemetry adjunct** (it hosts the existing
  `claude-otel-collector` + Grafana/Prometheus stack). Cluster down degrades
  dashboards only — session launch and LM Studio access are unaffected, and
  live-check/BE-4 prove it (plan §9.3 BE↔SI #5).
- **LM Studio stays bound to `127.0.0.1:1234`.** See "the 0.0.0.0 fallback"
  below for the only sanctioned exception.

## The probe — mandatory gate on EVERY colima/lima upgrade

The one fragile fact the adjunct depends on: a pod/guest can reach a host
service bound strictly to `127.0.0.1` via `host.lima.internal`. That was
proven empirically on **colima 0.10.1 / lima 2.1.1 / vz / macOS 26.6**
(findings §5: guest AND pod, by IP and by DNS name, no rebind) — and upstream
history (colima#698 NXDOMAIN-in-pods, colima#653) proves it can regress.
`infra/colima/pins.env` records that baseline; the probe re-proves it:

```sh
# routine health read (also: infra/ci/live-check.sh --check colima-probe)
infra/colima/probe-pod-host-loopback.sh                    # LM Studio target
infra/colima/probe-pod-host-loopback.sh --port 11434 --path /api/version   # Ollama stand-in
```

Semantics (all legs read-only; the probe never starts/stops anything):

| Result | Exit | Meaning |
|---|---|---|
| `GREEN` | 0 | pins match + VM running + target up host-side + guest (and pod, if available) reached `host.lima.internal:<port>` — gate certified |
| `DOWN` | 3 | something prerequisite is down (toolchain absent / VM stopped / target service down) — an honest state, **nothing is auto-started** |
| `RED` | 1 | version drift without `--allow-drift`, or the loopback leg failed while the target is up — **regression; do not accept this state** |

At milestone gates the probe rides `infra/ci/live-check.sh --check
colima-probe` (M4 registry entry), which maps GREEN/DOWN/RED to
PASS/SKIP(pending-owner)/FAIL — a stopped VM can never fail the gate run,
and a loopback regression can never hide as a skip.

### Upgrade procedure (owner-run; brew mutations are the owner's)

1. **Before touching anything:** run the probe on the current stack — it
   must be GREEN (certifies the baseline you can roll back to).
2. Owner upgrades colima/lima (e.g. `brew upgrade colima lima`) and restarts
   the VM at the owner's convenience (VM stop/start is owner-gated; brief
   downtime).
3. Re-run the probe with `--allow-drift` (installed versions now differ from
   `pins.env` — the DRIFT report is expected). If the k3s adjunct is in
   service, add `--require-pod-leg` so a skipped pod leg cannot masquerade
   as a pass.
4. **GREEN** → update `infra/colima/pins.env` to the new versions **in the
   same change**, appending a dated line to its verification record.
   **RED** → do NOT keep the upgrade: roll back to the pinned versions
   (`brew` pin/rollback), or — only if rolling back is impossible — work the
   fallback ladder below. Never update the pins on a RED run.

### Fallback ladder if loopback forwarding ever regresses (findings §5)

1. `colima start --network-address` (host-reachable VM IP; different
   reachability characteristics) — owner-gated VM restart.
2. Static CoreDNS rewrite / manual Endpoints / `hostAliases` pointing at
   `192.168.5.2` — leaks environment detail into manifests; adjunct-only.
3. **The 0.0.0.0 LM Studio rebind — STRICTLY FALLBACK, last resort** (see
   below).

## Owner-gated: VM right-size (VERBAL OK required)

The running profile reserves **8 CPU / 24 GiB** of the 36 GiB M4 Max, and vz
memory ballooning is broken (guest-touched memory never returns until VM
restart — lima#2789/#4220): a standing threat to LM Studio model loads
(5–20+ GiB unified memory). The decided change (plan §6/SI-5, findings
recommendation #3):

- **Target: ~4 CPU / 8–12 GiB** (confirm the aux stack — otel-collector,
  Grafana/Prometheus, KEDA — fits before choosing the low end; findings open
  question #6).
- Procedure (owner, after explicit VERBAL OK — brief downtime, done once):
  `colima stop && colima start --cpu 4 --memory 8` (adjust memory per the
  confirmation above). The k3s workloads come back on their own; verify with
  the probe (`--require-pod-leg`) afterwards.
- **No agent runs this.** Until the owner OK lands, live-check reports the
  right-size as pending-owner and everything continues to work at the
  current size.

## Owner-gated: delete the dormant x86_64 profile (VERBAL OK required)

`colima list` shows a second, stopped `containerd` profile: x86_64/qemu,
**16 GiB reserved on paper** (dormant since the findings inspection). It
serves no harness purpose. On the owner's explicit OK:
`colima delete <profile-name>` (destructive — confirm the profile name from
`colima list` first; nothing in the harness references it). Never run by an
agent.

## The 0.0.0.0 LM Studio rebind — strictly fallback, never the default

Recorded for completeness (findings §5 fallback 2). If — and only if — a
future colima/lima version regresses loopback forwarding AND rolling back is
impossible AND the k8s adjunct still needs to consume LM Studio:

- `lms server start --bind 0.0.0.0` (or GUI "Serve on Local Network" /
  `LMS_SERVER_HOST`) **must** be paired with **API token auth enabled** and
  **macOS Application Firewall rules** restricting the listener — an
  unauthenticated 0.0.0.0 bind is an open inference endpoint on any shared
  network.
- This is a fallback for the ADJUNCT plane only. The harness's own LM Studio
  path is host-native `127.0.0.1` and never needs it. Revert to the
  `127.0.0.1` bind the moment the forwarding path is green again.

## Grafana/Prometheus adjunct — DOCUMENTED ONLY (no wiring performed)

The existing in-cluster stack (kube-prometheus-stack + Grafana, plus the
`claude-otel-collector` with OTLP 4317/4318 and dashboard 7173) MAY be kept
as a **secondary consumer** of Claude Code telemetry alongside the harness's
own host-native OTLP receiver (BE-5, `127.0.0.1:4318`):

- Pattern: the per-account OTel env (SI-3) points sessions at the harness
  receiver; if the owner wants the Grafana view too, the sanctioned shape is
  a host-side forwarding exporter from the harness receiver to the cluster
  collector's forwarded port — **not** dual `OTEL_EXPORTER_OTLP_ENDPOINT`
  hacks in account settings, and never a harness dependency on the cluster.
- Candidate for later retirement (plan §6/SI-5): if the harness dashboards
  (FE-5) cover the owner's needs, the cluster stack can be dropped with the
  VM decision at any time. No configuration for this adjunct lives in the
  repo; this section is the documentation of record.

## [X2] notes

- Nothing in `infra/colima/` carries identity: pins are public version
  strings; probe output carries ports, profile names, and doc pointers only.
- The probe's in-guest/in-pod commands are plain HTTP GETs; the bats suite
  pins that statically (no non-GET curl, no kubectl mutations, no `colima
  start|stop|delete|kubernetes`) and via the stub invocation log.
