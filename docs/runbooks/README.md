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
| [login-bootstrap.md](login-bootstrap.md) | **live** | One interactive `claude /login` per account, ever — per-account config dirs + Keychain isolation (SI-2). |
| [version-gate.md](version-gate.md) | **live** | Mandatory checks before any SDK bump, incl. the keychain-deletion canary (SI-2). |
| [kernel-live-spawn.md](kernel-live-spawn.md) | **live** | Enabling the kernel's real claude spawn path (T3, owner-gated) — the [X1] live acceptance run. |
| `recovery.md` | planned (M6) | Broker crash/orphan recovery via the resume ledger. |
| `quota-exhaustion.md` | planned (M6) | What to do when an account hits its 5h/weekly limits. |
| `colima-upgrade-gate.md` | planned (SI-5) | Pod→host loopback probe as a mandatory gate on colima/lima upgrades. |

## Machine-local runtime layout (documented here, never committed)

```
~/.aibender/
├── accounts/{max-a,max-b,ent}/   # per-account CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR
├── db/                            # SQLite ledgers
├── bootstrap/                     # gateway port/token discovery file
├── logs/
└── private/                       # tier-2 gitleaks config, label→account mapping (chmod 600)
```
