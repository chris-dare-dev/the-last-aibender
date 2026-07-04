# [X3] Colima + k3s + SOPS Evaluation — LM Studio Connectivity as Hard Gate

**Stage-1 discovery research — the-last-aibender**
**Date:** 2026-07-03 · **Researcher:** Claude (stage-1 discovery agent)
**Verdict:** **PARTIAL** — SOPS: adopt unconditionally. k3s-in-Colima: keep as optional adjunct for stateless auxiliary services only (it already runs on this machine and passed the LM Studio connectivity gate empirically). Harness core (Claude sessions, LM Studio, frontend/backend): **host-native** (launchd + per-account `CLAUDE_CONFIG_DIR`).

---

## TL;DR

1. **The hard gate PASSES on the current stack, verified empirically today**: a pod inside k3s-in-Colima reached a host service bound strictly to `127.0.0.1` (Ollama :11434, a perfect LM Studio stand-in) via `host.lima.internal` → `192.168.5.2`, by IP *and* by DNS name — **no 0.0.0.0 rebinding required**.
2. But this behavior is **version-fragile**: older Colima/Lima issues report NXDOMAIN for `host.*.internal` inside pods; treat it as working-but-pin-and-health-check, not guaranteed.
3. **LM Studio can never run inside the VM anyway** — Apple Virtualization.framework gives Linux guests no Metal/GPU access; LM Studio inference is host-native by physics, so k8s only ever *consumes* it.
4. **The [X1] auth conflict is real but not a hard block**: Linux pods have no Keychain; official fallbacks (`~/.claude/.credentials.json`, `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`, 1-year, Pro/Max/Team/Enterprise) are documented and legitimate — yet containerizing sessions adds OAuth-refresh-race risk, secret-distribution surface, and zero isolation benefit over `CLAUDE_CONFIG_DIR`.
5. **Resource math is hostile**: the existing Colima VM reserves 8 CPU / 24 GiB of the 36 GiB M4 Max; vz memory ballooning is broken (memory grows to cap and never returns), directly starving LM Studio model loads.
6. **Host-native launchd + per-account `CLAUDE_CONFIG_DIR` achieves [X1] isolation with ~zero overhead** — newer Claude Code versions even derive a distinct Keychain entry per config dir.
7. **SOPS is not k8s-only**: adopt SOPS+age now for the public repo ([X2]) via `sops exec-env` host-native; Flux/helm-secrets slot in later if k8s grows.
8. This machine *already* runs a 282-day-old k3s-in-Colima cluster hosting a `claude-otel-collector` + Grafana observability stack — don't tear it down; consume it, but shrink the VM.

---

## Current landscape

### 1. Colima architecture (what actually runs)

[Colima](https://github.com/abiosoft/colima) is a thin lifecycle manager over [Lima](https://lima-vm.io/), which drives Linux VMs on macOS through one of two backends:

- **`vz`** — Apple's native Virtualization.framework (macOS 13+). Near-native CPU performance, Rosetta 2 for amd64 binaries inside the arm64 guest, and **virtiofs** file mounts (much faster than sshfs/9p). The VM itself materializes as a macOS XPC process: `com.apple.Virtualization.VirtualMachine`.
- **`qemu`** — slower, fully emulated; on Apple Silicon only sensible for running a foreign-arch (x86_64) guest.

Consensus and Lima's own docs recommend `vz` + `virtiofs` on Apple Silicon ([Lima VM types](https://lima-vm.io/docs/config/vmtype/), [Oracle blog](https://blogs.oracle.com/developers/running-containers-with-colima), [deep dive](https://minimaldevops.com/what-powers-colima-rancher-desktop-and-finch-a-deep-dive-into-lima-and-qemu-f8d2f2387eb5)).

**Ground truth on this Mac (read-only inspection, 2026-07-03):**

| Item | Value |
|---|---|
| Colima | 0.10.1 (runtime docker, arch aarch64) |
| Lima | limactl 2.1.1 |
| Default profile | **Running**: 8 CPU, 24 GiB RAM, 100 GiB disk, `vmType: vz`, `rosetta: true`, `mountType: virtiofs`, `docker+k3s` |
| Second profile | `containerd`: stopped, x86_64/qemu, 16 GiB (dormant reservation) |
| Guest OS | Ubuntu 24.04.2 LTS, kernel 6.8, docker 28.4.0 |
| k3s | **active**, `v1.33.4+k3s1`, node age **282 days**, `--disable=traefik` |
| Workloads | `claude-otel-collector` (+ OTLP LoadBalancer 4317/4318, dashboard 7173), kube-prometheus-stack + Grafana, KEDA, an MCP app |
| SOPS | 3.13.0 installed on host |
| kubectl | v1.32.2 installed on host |

So this is not a greenfield evaluation: **Chris already runs k3s-in-Colima**, and it already hosts the Claude Code telemetry pipeline the harness's observability feature will want to read.

### 2. Running k3s inside Colima

`colima start --kubernetes` boots [k3s](https://k3s.io/) inside the VM. Colima 0.10.1 exposes (verified via `colima kubernetes --help` / `colima start --help`):

- `--kubernetes-version` (must match a k3s release; current default `v1.35.0+k3s1`)
- `--k3s-arg` (default `--disable=traefik`)
- `colima kubernetes start|stop|reset|delete` — **`reset` recreates the cluster** (workloads are lost unless re-applied; version upgrades effectively go through reset)
- kubeconfig merged into `~/.kube/config` as context `colima`, API reached through a host port-forward.

### 3. Real resource overhead on this 36 GiB M4 Max

- **Static reservation:** the running profile pins **8 of 14 CPU cores and 24 GiB of 36 GiB RAM** as VM capacity. Lima/vz allocates lazily, but…
- **Memory ballooning is broken under vz**: once the guest touches memory (and Linux page cache counts), the host-side VM process grows toward the cap and **never shrinks until VM restart** — a known macOS/Lima defect ([lima#2789](https://github.com/lima-vm/lima/issues/2789), [discussion #2720](https://github.com/lima-vm/lima/discussions/2720), tracking [lima#4220](https://github.com/lima-vm/lima/issues/4220)). Guest currently shows 5.9 GiB used + **16 GiB page cache** of 23 GiB — i.e. the guest has already touched ~22 GiB.
- **Measured now:** VM process RSS 2.11 GB (post-restart 12 days ago; will climb), and the VM process was consuming **~188% CPU** during a brief kubectl-probe window. k3s alone idles at ~500–600 MB and a few % CPU ([k3s resource profiling](https://docs.k3s.io/reference/resource-profiling), [k3s#3558](https://github.com/k3s-io/k3s/discussions/3558)); the kube-prometheus stack multiplies that. Colima idle-CPU complaints exist upstream ([colima#1543](https://github.com/abiosoft/colima/issues/1543), Lima-based Rancher Desktop ~20% idle CPU with k8s on ([rancher-desktop#7087](https://github.com/rancher-sandbox/rancher-desktop/issues/7087))).
- **Direct conflict with LM Studio:** loading a 7B–32B model host-side needs roughly 5–20+ GiB of unified memory. A ballooned 24 GiB VM + LM Studio + Claude sessions + Electron-class frontend on 36 GiB = swap/thrash. If the VM stays, it must shrink (8–12 GiB is ample for the current aux workloads).

### 4. Operational burden

- **Lifecycle:** `colima start/stop` (~30–60 s cold start with vz); no built-in supervision — `brew services start colima` or a LaunchAgent is needed for boot persistence. macOS point-updates have broken VM boot historically ([colima#683](https://github.com/abiosoft/colima/issues/683) after macOS 13.3).
- **Upgrades:** three independent version axes (colima, lima, k3s). k3s version bumps ride `colima kubernetes reset` (cluster state rebuilt).
- **Observed live failure mode:** at inspection time, `kubectl` from the host failed (`127.0.0.1:6445 connection refused`) while the cluster was perfectly healthy inside the VM — the host-side API port-forward/kubeconfig had gone stale across restarts. Anecdotal but representative of the class of glue that silently rots ([colima discussion #934](https://github.com/abiosoft/colima/discussions/934) covers port-forwarding behavior).

### 5. NETWORKING — the LM Studio hard gate (empirically tested)

**Topology (verified in-guest):** Lima user-mode network, guest eth0 `192.168.5.1`, gateway `192.168.5.2`, `/etc/hosts` maps `host.lima.internal` **and** `host.docker.internal` → `192.168.5.2`; guest `resolv.conf` → usernet resolver; k3s pods on flannel `10.42.0.0/24` route out via the guest default gateway ([Lima user-mode network docs](https://lima-vm.io/docs/config/network/user/)).

**The decisive experiments (all read-only, run 2026-07-03 on this exact stack).** LM Studio was down, but Ollama was listening on host `127.0.0.1:11434` **loopback-only** (confirmed via `lsof`) — the *identical* bind situation as LM Studio's default `127.0.0.1:1234`:

| Test | Result |
|---|---|
| Guest → `http://host.lima.internal:11434/api/version` | ✅ `{"version":"0.30.10"}` — **VM reaches host loopback-bound service** |
| Pod (`kubectl exec` into existing Grafana pod) → `getent hosts host.lima.internal` | ✅ resolves to `192.168.5.2` (via CoreDNS → forward → node resolver; note: k3s's `NodeHosts` ConfigMap does **not** contain the entry — resolution comes from the DNS forward path) |
| Pod → `http://192.168.5.2:11434/api/version` | ✅ reached host loopback service **by IP** |
| Pod → `http://host.lima.internal:11434/api/version` | ✅ reached it **by name** |

**Conclusion:** on Colima 0.10.1 / Lima 2.1.1 / vz / macOS 26.6, the Lima usernet gateway forwards guest→`192.168.5.2` connections such that they originate on the host loopback — so **a pod can consume LM Studio at its default, safe `127.0.0.1:1234` binding. The "bind to 0.0.0.0" requirement does not exist on this stack.**

**Why the caution flag stays up:** upstream history says this has not always been true — [colima#698](https://github.com/abiosoft/colima/issues/698) ("host.docker.internal not available in pods", NXDOMAIN) and [colima#653](https://github.com/abiosoft/colima/issues/653) (ingress → local service = bad gateway) document exactly the failure the hard gate fears, on older Lima networking. The Lima docs themselves don't promise loopback reachability through the gateway ([user network docs](https://lima-vm.io/docs/config/network/user/)). Treat the working state as an implementation detail: **pin colima/lima versions, and make the harness run a startup connectivity probe** (pod-side `GET http://host.lima.internal:1234/v1/models`) whenever the k8s path is used.

**Fallbacks if a future version regresses:**
1. `colima start --network-address` — gives the VM a host-reachable IP (~`192.168.106.x`) with different reachability characteristics.
2. Bind LM Studio to LAN: GUI "Serve on Local Network", or headless `lms server start --bind 0.0.0.0` (flag verified locally in `lms` help; also `LMS_SERVER_HOST`) ([serve-on-network docs](https://lmstudio.ai/docs/developer/core/server/serve-on-network), [lms server start](https://lmstudio.ai/docs/cli/serve/server-start)). **Security implications:** the API then listens on every interface **without authentication by default** — on café Wi-Fi that is an open inference endpoint (and MCP access surface). LM Studio now supports requiring API tokens ([server settings](https://lmstudio.ai/docs/developer/core/server/settings)); pair 0.0.0.0 with token auth + macOS Application Firewall rules, or better, don't leave the default 127.0.0.1 world at all.
3. Static CoreDNS rewrite / manual `Endpoints` object pointing at `192.168.5.2`, or `hostAliases` in pod specs (works, but leaks environment detail into manifests — the complaint in colima#698).

### 6. The CRITICAL auth conflict — Claude Code credentials in a Linux pod ([X1])

**How auth is stored (official [authentication docs](https://code.claude.com/docs/en/authentication)):**
- macOS → **encrypted Keychain**. Verified on this host: generic-password item **"Claude Code-credentials"** in `login.keychain-db`; **no** `~/.claude/.credentials.json` exists (Claude Code 2.1.193).
- Linux → `~/.claude/.credentials.json` (mode 0600), living under `CLAUDE_CONFIG_DIR` if set. This is the *documented, first-class* Linux path — not a hack. Inside a pod there is simply no Keychain, so this is what you get.

**Documented fallbacks for non-interactive/containerized use:**
- **`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`**: official, one-year, OAuth-authorized token for "CI pipelines, scripts, or other environments where interactive browser login isn't available". Requires **Pro, Max, Team, or Enterprise** — so it is *legitimate and supported for MAX_A, MAX_B, and ENT alike*. Scope: inference only; can't do Remote Control; **`--bare` mode ignores it** (use `apiKeyHelper`/API key there).
- **Interactive login in a container** works via the paste-code flow; the official [devcontainer guide](https://code.claude.com/docs/en/devcontainer) recommends persisting `~/.claude` in a volume. Community field reports note **both** `.credentials.json` *and* `.claude.json` must persist or Claude re-prompts login ([field-notes#10](https://github.com/tfvchow/field-notes-public/issues/10), [claude-code#22066](https://github.com/anthropics/claude-code/issues/22066)).

**Stability hazards (these are the real risk, and they exist host-side too):**
- **OAuth refresh-token races**: many open upstream issues describe concurrent sessions sharing one credential store racing to refresh a single-use rotating refresh token, producing cascading forced logouts ([#24317](https://github.com/anthropics/claude-code/issues/24317), [#27933](https://github.com/anthropics/claude-code/issues/27933), [#25609](https://github.com/anthropics/claude-code/issues/25609), [#43392](https://github.com/anthropics/claude-code/issues/43392), [#56339](https://github.com/anthropics/claude-code/issues/56339)). Key insight for the harness: the race is **per credential store, not per OS** — parallel sessions *within one account* can trip it on macOS Keychain just as in a shared credentials file. `CLAUDE_CODE_OAUTH_TOKEN` (no refresh cycle for a year) is the strongest mitigation for headless parallel fleets.
- **Foot-guns:** `CLAUDE_CODE_OAUTH_TOKEN` silently overrides file credentials ([#16238](https://github.com/anthropics/claude-code/issues/16238)) and has been reported to clobber macOS Keychain credentials on exit ([#37512](https://github.com/anthropics/claude-code/issues/37512)) — don't mix modes within one config dir.
- **Distribution surface:** putting three accounts' year-long tokens into k8s Secrets inside a VM raises exfiltration surface (Anthropic's own devcontainer warning: anything in the container, including `~/.claude` credentials, is exfiltratable by a malicious workspace under `--dangerously-skip-permissions`).

**Multi-account isolation without containers:** `CLAUDE_CONFIG_DIR` gives fully separate profiles; current Claude Code versions derive a **distinct Keychain entry per config dir** (`Claude Code-credentials-<sha256-prefix of path>`), so MAX_A / MAX_B / ENT can live side-by-side, each with independent OAuth state, launched concurrently ([community pattern write-ups](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2), [claude-profile](https://blog.wiredgeek.net/tools/claude-code/2026/04/06/managing-multiple-claude-code-profiles.html), [side-by-side guide](https://daring-designs.com/blog/how-to-run-multiple-claude-code-accounts-side-by-side)).

**Answer to the topic question:** containerization does **not** hard-break [X1] — file credentials and setup-token are legitimate, documented, plan-supported paths — but it buys *nothing* for [X1] that `CLAUDE_CONFIG_DIR` doesn't already provide host-native, while adding refresh-race exposure, secret plumbing, VM RAM tax, and the loss of the Keychain (the best secret store on the machine).

### 7. Where SOPS fits in EACH scenario (it is not k8s-only)

[SOPS](https://github.com/getsops/sops) (v3.13.0 already installed) encrypts *values* in YAML/JSON/env/ini files against age/GPG/KMS keys — the [X2] public-repo answer regardless of runtime:

- **Host-native (recommended default):** `age-keygen` once → private key in `~/.config/sops/age/keys.txt` (never in repo) → commit `secrets/*.enc.yaml` publicly. Runtime injection without plaintext on disk: `sops exec-env secrets/dev.enc.yaml 'the-harness ...'`; shell ergonomics via [direnv's `use_sops`](https://github.com/direnv/direnv/wiki/Sops) or [mise's native sops support](https://mise.jdx.dev/environments/secrets/sops.html). LaunchAgents can wrap their `ProgramArguments` in `sops exec-env`. This cleanly holds placeholder-sensitive values (AWS_DEV_ACCOUNT_ID, the Bedrock key name, per-account config-dir paths) out of the tree.
- **k8s scenario:** identical encrypted files, decrypted in-cluster by [Flux kustomize-controller's native SOPS support](https://fluxcd.io/flux/guides/mozilla-sops/) (age key as `sops-age` Secret), [helm-secrets](https://github.com/jkroepke/helm-secrets) for chart values, or [sops-secrets-operator](https://github.com/isindir/sops-secrets-operator) without GitOps.
- **Hybrid:** one `.sops.yaml` creation-rule file serves both consumers — adopting SOPS now loses nothing if k8s usage grows later.

---

## Options considered

### Option A — Full adoption: harness core + Claude sessions + everything in k3s-in-Colima

**How it works:** harness backend, workflow engines, and per-account Claude Code sessions run as pods; per-account credentials delivered as k8s Secrets (`CLAUDE_CODE_OAUTH_TOKEN` or mounted `.credentials.json` under `CLAUDE_CONFIG_DIR`); LM Studio consumed over `host.lima.internal:1234`; SOPS via Flux/helm-secrets.

**Pros:** uniform deploy artifact (charts), restart policies/health checks for free, strong workspace isolation for `--dangerously-skip-permissions` fleets, declarative reproducibility, portable to a future beefier host or cloud.

**Cons:** 24 GiB/8-CPU VM tax on a 36 GiB laptop with broken vz ballooning; LM Studio **cannot** join it (no Linux-guest GPU/Metal in Virtualization.framework) so the "unified" substrate is permanently split anyway; every UI-facing feature (context-graph file watching of host `~/.claude`, `.claude/` workspace scans) needs virtiofs mounts of host dirs into pods — slow and permission-brittle; three year-long account tokens replicated into cluster Secrets; interactive login flows inside pods are paste-code-clunky; version fragility of the pod→host loopback path.

**Risks:** a colima/lima upgrade regresses `host.lima.internal` semantics (historical precedent: colima#698) → LM Studio unreachable → hard-gate breach; OAuth refresh races multiply with fleet size; VM memory creep starves LM Studio model loads; macOS updates break VM boot at the worst time.

### Option B — PARTIAL: host-native harness core; k3s-in-Colima retained for stateless auxiliary services

**How it works:** Claude Code sessions (MAX_A/MAX_B/ENT via per-account `CLAUDE_CONFIG_DIR`), OpenCode, LM Studio, and the harness frontend/backend all run host-native under launchd supervision. The **existing** k3s cluster keeps doing what it already does — `claude-otel-collector` (OTLP :4317/:4318), Grafana/Prometheus, KEDA — which the harness *consumes* for its observability panel. VM gets right-sized (e.g. 4 CPU / 8–12 GiB). SOPS+age host-native; Flux optional in-cluster.

**Pros:** zero disruption to the running 282-day observability pipeline the harness needs anyway; harness core has no VM dependency (LM Studio at plain `127.0.0.1:1234`; hard gate trivially satisfied); Keychain stays the credential store; k8s skills/tooling remain exercised; reclaims ~12–16 GiB for models.

**Cons:** two operational planes (launchd + k8s); the pod→host path still needs the pinned-version + health-probe discipline for the collector→(host services) direction if ever needed; VM resize requires a `colima stop && colima start --memory N` (brief downtime, done once).

**Risks:** minor — cluster outage degrades only dashboards/telemetry, never session launch or LM Studio. Stale host-side kubeconfig forwards (observed live) affect only the aux plane.

### Option C — Host-native everything: launchd + per-account config dirs, no VM at all

**How it works:** LaunchAgents supervise `lms server start` (KeepAlive), the harness backend, and optional Ollama; per-account wrappers export `CLAUDE_CONFIG_DIR=~/.claude-<MAX_A|MAX_B|ENT>`; parallel sessions are plain processes; secrets via SOPS+age (`sops exec-env`) + macOS Keychain; existing k3s cluster decommissioned or ignored, telemetry collector re-homed as a host process (otel-collector has native darwin builds).

**Pros:** minimal complexity and RAM overhead; [X1] fully satisfied (isolated Keychain entries per config dir; no shared-store refresh races *across* accounts); LM Studio connectivity is a non-question; frontend's live file-watching of `~/.claude`/workspaces is direct fsevents, no mount indirection.

**Cons:** loses k8s conveniences (declarative restarts, KEDA, in-cluster Grafana) — launchd's KeepAlive is cruder; re-homing the existing observability stack is real migration work with no functional payoff versus Option B; no scale-out story beyond this laptop.

**Risks:** launchd unit sprawl without the discipline charts impose; process-level (not namespace-level) isolation means a rogue `--dangerously-skip-permissions` session sees the whole host — mitigated by Claude Code's own sandbox/permissions rather than container walls.

### Option D (noted, not pursued) — Plain containers on Colima's docker runtime, no k3s

Docker-compose-style services on the already-running docker+vz VM: same networking findings apply (`host.docker.internal` works from *containers* even historically — the pod-DNS gap was the k3s-specific issue). Strictly less machinery than k3s, but still inherits the VM RAM tax and adds nothing for the harness core over Option C.

---

## Recommendation (opinionated)

**PARTIAL — concretely Option B, with Option C's discipline for the harness core.**

1. **SOPS + age: ADOPT now, unconditionally.** It is the [X2] enforcement mechanism in every scenario. One `.sops.yaml`, encrypted env files committed to the public repo, `sops exec-env` wrapping harness processes, age private key outside the tree. Nothing about this waits on the k8s decision.
2. **Harness core: host-native. Do not put Claude Code sessions, LM Studio, or the frontend/backend in k3s.**
   - LM Studio stays host-native *by necessity* (no guest GPU) at default `127.0.0.1:1234` — never flip on "Serve on Local Network" for this architecture; the harness supervises it via `lms server start/stop/status` (CLI verified at `~/.lmstudio/bin/lms`) under a LaunchAgent, and treats "down" as a first-class state (it is down today).
   - Sessions: one `CLAUDE_CONFIG_DIR` per account (MAX_A, MAX_B, ENT), yielding per-account Keychain entries and parallel logins without re-auth — this satisfies [X1] with the least moving parts. For headless/fleet parallelism, prefer per-account `claude setup-token` values (1-year, refresh-race-free), stored in Keychain/SOPS — never in the repo, and never mixed with OAuth-file mode in the same config dir.
3. **k3s-in-Colima: KEEP, but demote and shrink.** It already hosts the Claude OTEL collector + Grafana the harness's observability panel will read — that is a legitimate, working use. Right-size the VM (4 CPU / 8–12 GiB; today's 8 CPU / 24 GiB with broken vz ballooning is a standing threat to LM Studio model memory), delete the dormant 16 GiB x86_64 profile, pin colima/lima versions, and add a harness health probe for any pod→host dependency. The harness must **degrade gracefully** when the cluster is absent — it is an adjunct, never a dependency of session launch or LM Studio access.
4. **Honor the gate going forward:** the empirical result (pod → host `127.0.0.1`-bound service via `host.lima.internal`, no rebind) is recorded here with versions; any Colima/Lima upgrade must re-run that probe before being accepted.

---

## Implications for the harness

- **Architecture split:** "control plane" (frontend/backend, session launcher, file watchers) = host processes under launchd; "telemetry plane" (OTLP collector :4317/:4318, dashboards :7173, Grafana) = existing k3s services, consumed over forwarded ports, optional at runtime.
- **LM Studio manager module:** detect via `GET http://127.0.0.1:1234/v1/models` (observed failure mode today: connection refused), start via `lms server start` (LaunchAgent, KeepAlive), surface up/down in the UI. Keep binding at 127.0.0.1; document `--bind 0.0.0.0` + LM Studio API-token auth + firewall strictly as the recorded fallback for a future k8s consumer if usernet semantics ever regress.
- **Account/session launcher:** wrapper per account exporting `CLAUDE_CONFIG_DIR`; never share a config dir across accounts; within an account, be aware of upstream refresh-race issues for many simultaneous headless processes — setup-token mode is the mitigation. `--bare` mode won't read `CLAUDE_CODE_OAUTH_TOKEN`.
- **Secrets layout ([X2]):** commit only SOPS-encrypted files; placeholders (MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID) in docs; real values only in Keychain, `~/.config/sops/age/keys.txt`, or encrypted payloads. The Bedrock key already lives in Keychain (item `bedrock-openai-api-key`) — the harness should read it at runtime, mirroring the existing `oc-bedrock` pattern.
- **Context-graph watcher ([vision #6]):** host-native fsevents on `~/.claude` and workspace `.claude/` dirs — another reason the core must not sit behind virtiofs inside a VM.
- **Version pinning:** record colima 0.10.1 / lima 2.1.1 / k3s v1.33.4+k3s1 / macOS 26.6 as the verified-good networking baseline; upgrades gated on re-running the pod→host probe.
- **Resource budget:** after VM right-sizing, plan roughly: LM Studio + one mid-size model 8–16 GiB; VM ≤12 GiB; sessions/frontend/OS the remainder of 36 GiB.

---

## Sources

**Colima / Lima / vz**
- https://github.com/abiosoft/colima · https://colima.run/ · https://colima.run/docs/configuration/
- https://lima-vm.io/docs/config/network/ · https://lima-vm.io/docs/config/network/user/
- https://lima-vm.io/docs/config/vmtype/ · https://lima-vm.io/docs/config/vmtype/vz/
- https://github.com/lima-vm/lima/issues/2789 (memory not freed on VZ) · https://github.com/lima-vm/lima/discussions/2720 · https://github.com/lima-vm/lima/issues/4220 (ballooning support)
- https://github.com/abiosoft/colima/issues/1543 (idle CPU) · https://github.com/abiosoft/colima/issues/683 (macOS update breakage) · https://github.com/abiosoft/colima/discussions/934 (port forwarding)
- https://github.com/rancher-sandbox/rancher-desktop/issues/7087 (Lima-family k8s idle CPU)
- https://blogs.oracle.com/developers/running-containers-with-colima · https://minimaldevops.com/what-powers-colima-rancher-desktop-and-finch-a-deep-dive-into-lima-and-qemu-f8d2f2387eb5

**Pod→host networking (historical failures)**
- https://github.com/abiosoft/colima/issues/698 (host.docker.internal NXDOMAIN in pods) · https://github.com/abiosoft/colima/issues/653 (ingress → local host service)

**k3s footprint**
- https://docs.k3s.io/reference/resource-profiling · https://github.com/k3s-io/k3s/discussions/3558

**Claude Code auth / containers**
- https://code.claude.com/docs/en/authentication (credential storage, precedence, `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`)
- https://code.claude.com/docs/en/devcontainer (official containerized guidance, `~/.claude` volume, security warning)
- Refresh-race and credential issues: https://github.com/anthropics/claude-code/issues/24317 · /issues/27933 · /issues/25609 · /issues/43392 · /issues/56339 · /issues/37512 · /issues/16238 · /issues/22066 · https://github.com/tfvchow/field-notes-public/issues/10
- Multi-account patterns: https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2 · https://blog.wiredgeek.net/tools/claude-code/2026/04/06/managing-multiple-claude-code-profiles.html · https://daring-designs.com/blog/how-to-run-multiple-claude-code-accounts-side-by-side

**LM Studio**
- https://lmstudio.ai/docs/developer/core/server/serve-on-network · https://lmstudio.ai/docs/cli/serve/server-start · https://lmstudio.ai/docs/developer/core/server/settings · https://github.com/lmstudio-ai/lms/issues/514

**SOPS**
- https://github.com/getsops/sops · https://fluxcd.io/flux/guides/mozilla-sops/ · https://github.com/direnv/direnv/wiki/Sops · https://mise.jdx.dev/environments/secrets/sops.html · https://github.com/jkroepke/helm-secrets · https://github.com/isindir/sops-secrets-operator

**Local empirical evidence (this machine, 2026-07-03):** `colima status/list`, `~/.colima/default/colima.yaml`, in-guest `getent/curl/free/ip route`, `kubectl exec` DNS+HTTP probes from a running pod, `lsof` bind checks, `security find-generic-password` (metadata only), `colima kubernetes --help`, `lms server start --help`.

---

## Open questions

1. **Durability of the loopback-forwarding behavior:** which exact Lima change made `host.lima.internal` resolvable/reachable from pods (usernet/user-v2 evolution), and is it a documented guarantee or incidental? Worth an upstream question before Stage-2 hard-codes it as fallback path.
2. **ENT policy surface:** can/does the Enterprise org's admin restrict `claude setup-token`, impose managed settings, or rotate seats in ways that invalidate a year-long token mid-flight? Needs a check against the actual ENT tenant policies (not testable read-only here).
3. **Upstream refresh-race fix:** several issues propose file-locking/coordination — is a fix landing that changes the parallel-session calculus within a single account?
4. **vz ballooning fix timeline** (lima#4220): if Apple/Lima fix memory return, the k8s RAM-tax argument weakens materially.
5. **Host→VM kubeconfig staleness root cause:** why is host `127.0.0.1:6445` refused while k3s is healthy — port drift across colima restarts, or a broken SSH forwarder? Needs one supervised `colima stop/start` cycle to diagnose (mutation — out of scope for this stage).
6. **Right-sizing the VM:** confirm the aux stack (otel-collector, Grafana/Prometheus, KEDA) fits comfortably in 8 GiB before shrinking from 24 GiB.
7. **Telemetry plane placement:** should Stage-2 consider re-homing the claude-otel-collector host-native (darwin builds exist) to eliminate the VM from the harness's read path entirely, or is keeping the existing k3s deployment the lower-effort stable choice?
