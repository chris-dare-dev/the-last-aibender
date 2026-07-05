# docs/runbooks/ — operator procedures

How a human operates this harness on a real machine. Runbooks are the only
place machine-local layout is documented — real values (account mapping,
tier-2 scanner literals, tokens) live under `~/.aibender/` and the Keychain,
**never in the tree** [X2].

## Index

| Runbook | Status | Purpose |
|---|---|---|
| [hygiene.md](hygiene.md) | **live** | Set up, verify, and re-prove the two-tier gitleaks gate (SI-1). |
| [m0-dod.md](m0-dod.md) | **record** | M0 definition-of-done gate record: per-item status, spike verdicts, pending-owner ledger. |
| [m1-dod.md](m1-dod.md) | **record** | M1 definition-of-done gate record: per-item status, synthetic X1 demo evidence ([m1-demo-output.txt](m1-demo-output.txt)), pending-owner ledger. |
| [m2-dod.md](m2-dod.md) | **record** | M2 definition-of-done gate record: per-item status, 6-PTY soak + echo-latency numbers, approval round-trip evidence, pending-owner ledger. |
| [m3-dod.md](m3-dod.md) | **record** | M3 definition-of-done gate record: per-item status, collector/read-model/dashboard proof citations, double identity audit, pending-owner ledger. |
| [m4-dod.md](m4-dod.md) | **record** | M4 definition-of-done gate record: lineage/hook-automation/merge/graph proof citations, 5k-soak fps numbers (incl. the WebKit pinned-pacing control), fs-audit evidence, co-sign record, pending-owner ledger. |
| [login-bootstrap.md](login-bootstrap.md) | **live** | One interactive `claude /login` per account, ever — per-account config dirs + Keychain isolation (SI-2). |
| [version-gate.md](version-gate.md) | **live** | Mandatory checks before any SDK bump, incl. the keychain-deletion canary (SI-2). |
| [kernel-live-spawn.md](kernel-live-spawn.md) | **live** | Enabling the kernel's real claude spawn path (T3, owner-gated) — the [X1] live acceptance run. |
| [launchd.md](launchd.md) | **live** (render) / T3 (bootstrap) | Broker + lms LaunchAgents: Aqua rule, KeepAlive crash check, Background expected-failure probe (SI-3). |
| [hooks-telemetry.md](hooks-telemetry.md) | **live** (headless) / T3 (real dirs) | Per-account hook settings: http event hooks, statusline quota tee, OTel env block (SI-3). |
| [bedrock-iac.md](bedrock-iac.md) | **live** (validation) / T3 (plan+apply, hard-gated) | Bedrock cost-attribution IaC: owner plan/apply sequence, verbal-OK gate, post-apply wiring (SI-4). |
| `recovery.md` | planned (M6) | Broker crash/orphan recovery via the resume ledger. |
| `quota-exhaustion.md` | planned (M6) | What to do when an account hits its 5h/weekly limits. |
| [colima.md](colima.md) | **live** (probe) / T3 (VM mutations, VERBAL OK) | Colima/k3s adjunct: version pins, the pod→host loopback probe as a mandatory gate on every colima/lima upgrade, owner-gated right-size + x86_64-profile deletion, 0.0.0.0 rebind strictly-fallback (SI-5). |

## Machine-local runtime layout (documented here, never committed)

```
~/.aibender/
├── accounts/{max-a,max-b,ent}/   # per-account CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR
├── bin/                           # installed helper scripts (statusline quota tee)
├── db/                            # SQLite ledgers
├── bootstrap/                     # gateway port/token discovery file
├── launchd/                       # rendered LaunchAgent plists (bootstrap is owner-run)
├── logs/
├── quota/                         # per-account statusline tee files <LABEL>.json (0600)
└── private/                       # tier-2 gitleaks config, label→account mapping (chmod 600)
```
