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
| [m5-dod.md](m5-dod.md) | **record** | M5 definition-of-done gate record: catalog-scanner + OpenCode-API-first citations, THE DEMO (3-step cross-account pipeline paused/resumed over the real composed broker), broker-restart journal-resume + real-process-group reaping proofs, per-step cost/lineage citations, co-sign record, pending-owner ledger (real catalog scan of real account dirs + real 3-backend run). |
| [m6-dod.md](m6-dod.md) | **record** | M6 (FINAL Stage-2) definition-of-done gate record: BE-9 supervision (induced-bloat watchdog, amber/red sacrifice order, accelerated `soak:m6` mechanism proof, composed recycle→lineage-continuity), packaging (dry-run bundle config + `--smoke-test`, NOT signed/flipped), the §9.3/§9.4 integration suites, co-sign flips, gate deviations, pending-owner ledger (real 24 h soak, real signed clean-account launch, LaunchAgent flip). |
| [stage2-complete.md](stage2-complete.md) | **record** | Stage-2 completion record (M0–M6): what each milestone shipped, the M6 gate evidence re-run at HEAD, the consolidated pending-owner ledger across all of Stage 2, and the hand-off to Stage 3 (adversarial review + rendered-frontend screen capture, which needs the owner's live logins). |
| [login-bootstrap.md](login-bootstrap.md) | **live** | One interactive `claude /login` per account, ever — per-account config dirs + Keychain isolation (SI-2). |
| [add-an-account.md](add-an-account.md) | **live** | Add a new Claude subscription account — the [X1] scalability procedure: write one manifest (open `MAX_<X>`/`ENT` form), provision, one login, probe. No code change (SI, ICR-0013). |
| [account-registry.md](account-registry.md) | **record** | Account-registry generalization change record (Stage 3): the closed 5-set → open `MAX_<X>`/`ENT` form + runtime registry, schema migrations 0005/0006, [X2] doctrine generalization, ICR-0013/0014 co-sign, and the N-account extensibility proof citations (ICR-0013). |
| [add-a-backend.md](add-a-backend.md) | **live** (register) / T3 (real health run) | Add a new local LLM / backend — the OS-1 scalability procedure: author one `BackendDescriptor` + one `registerBackend` call + an adapter factory + a health probe. No `vocab.ts` literal edit, no ~42-site branch fork, and **no migration** (0007/0008/0009 relaxed the CHECKs). The backend twin of [add-an-account.md](add-an-account.md) (SI, ICR-0016). |
| [os1-backend-registry.md](os1-backend-registry.md) | **record** | Backend-registry generalization change record (Stage 3, finding OS-1): the closed 3-tuple → `BackendDescriptor` + runtime registry, dispatch resolved through the descriptors, schema migrations 0007/0008/0009 moving the backend CHECK to the app layer, the byte-identical built-in preservation + synthetic 4th-backend end-to-end proof citations, and the BE/FE co-sign (ICR-0016). |
| [version-gate.md](version-gate.md) | **live** | Mandatory checks before any SDK bump, incl. the keychain-deletion canary (SI-2). |
| [kernel-live-spawn.md](kernel-live-spawn.md) | **live** | Enabling the kernel's real claude spawn path (T3, owner-gated) — the [X1] live acceptance run. |
| [launchd.md](launchd.md) | **live** (render) / T3 (bootstrap) | Broker + lms LaunchAgents: Aqua rule, KeepAlive crash check, Background expected-failure probe (SI-3). |
| [hooks-telemetry.md](hooks-telemetry.md) | **live** (headless) / T3 (real dirs) | Per-account hook settings: http event hooks, statusline quota tee, OTel env block (SI-3). |
| [bedrock-iac.md](bedrock-iac.md) | **live** (validation) / T3 (plan+apply, hard-gated) | Bedrock cost-attribution IaC: owner plan/apply sequence, verbal-OK gate, post-apply wiring (SI-4). |
| [recovery.md](recovery.md) | **live** (mechanism) / T3 (live drills) | Broker crash/orphan recovery via the resume ledger: startup reconciliation, the SIGKILL-orphan drill (pid+nonce verify → process-group reap), pipeline journal-resume (SI-6/M6). |
| [quota-exhaustion.md](quota-exhaustion.md) | **live** | What the cockpit shows + operator moves when an account hits its 5h/weekly limits: route around it, the fallback ladder, prevention (SI-6/M6). |
| [release-packaging.md](release-packaging.md) | **live** (dry-run/local) / T3 (real sign+notarize, install) | The dry-run → local ad-hoc bundle → Developer-ID sign + `xcrun notarytool` → clean-user-account launch owner sequence, incl. the tauri#11992 inside-out heal fallback (SI-6/M6). |
| [colima.md](colima.md) | **live** (probe) / T3 (VM mutations, VERBAL OK) | Colima/k3s adjunct: version pins, the pod→host loopback probe as a mandatory gate on every colima/lima upgrade, owner-gated right-size + x86_64-profile deletion, 0.0.0.0 rebind strictly-fallback (SI-5). |

## Machine-local runtime layout (documented here, never committed)

```
~/.aibender/
├── accounts/<stem>/              # one per profile manifest (max-a, max-b, max-c, max-d, ent, …)
│                                 #   per-account CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR
├── bin/                           # installed helper scripts (statusline quota tee)
├── db/                            # SQLite ledgers
├── bootstrap/                     # gateway port/token discovery file
├── launchd/                       # rendered LaunchAgent plists (bootstrap is owner-run)
├── logs/
├── quota/                         # per-account statusline tee files <LABEL>.json (0600)
└── private/                       # tier-2 gitleaks config, label→account mapping (chmod 600)
```
