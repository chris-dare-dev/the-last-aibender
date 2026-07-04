# infra/profiles/ — account profile manifests (SI-2, [X1] host side)

Machine-local path **conventions** for the three Claude accounts, keyed by the
sanctioned placeholder labels only — **MAX_A / MAX_B / ENT**. No real identity
(emails, org/account UUIDs, AWS IDs) ever appears here [X2]; the real mapping
lives machine-locally per [identity-map.example.json](identity-map.example.json).

Sources of record: blueprint §3 ([X1] mechanism), plan §6/SI-2,
[x1-parallel-multi-account](../../docs/research/findings/x1-parallel-multi-account.md).

## Files

| File | Purpose |
|---|---|
| `max-a.profile.json` / `max-b.profile.json` / `ent.profile.json` | One manifest per account label — dir convention, pinned env, keychain naming rule. |
| `identity-map.example.json` | Pointer only. The real label→identity map is `$AIBENDER_HOME/identity-map.json`, never committed. |

## Manifest schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "label": "MAX_A",                  // MAX_A | MAX_B | ENT — the only identities in the tree
  "kind": "max",                     // max | enterprise
  "rung": 1,                         // fallback-ladder rung this manifest implements (blueprint §3)
  "pathConvention": "$AIBENDER_HOME/accounts/max-a",
  "env": {
    // CLAUDE_SECURESTORAGE_CONFIG_DIR is PINNED equal to CLAUDE_CONFIG_DIR.
    // Scripts and BE-1 MUST refuse a manifest where they differ.
    "CLAUDE_CONFIG_DIR": "$AIBENDER_HOME/accounts/max-a",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR": "$AIBENDER_HOME/accounts/max-a"
  },
  "keychain": { ... }                // expected service-name derivation (see below)
}
```

## Expansion rule (byte-stability contract — blueprint §3 rule 2)

Every consumer (the `infra/scripts/accounts/*.sh` scripts, BE-1's profile
registry) MUST expand conventions identically, or the account silently "logs
out" (the CLI looks at a different, empty keychain slot):

1. Resolve `AIBENDER_HOME` (env; default `~/.aibender` **expanded to an
   absolute path**). Reject relative values.
2. Canonicalize: strip trailing slashes. No realpath/symlink resolution — the
   CLI hashes the **raw string** it receives, so the convention string itself
   is the contract.
3. Replace the literal leading `$AIBENDER_HOME` in the manifest value with
   that canonical string. The result is the byte-stable absolute path passed
   on **every** launch, forever.

## Keychain service-name derivation (verified)

With `CLAUDE_SECURESTORAGE_CONFIG_DIR` set, the credentials Keychain item is:

```
service = <serviceBase> + "-" + first 8 hex of sha256( NFC(dir string) )
        = "Claude Code-credentials-<hash8>"      (prod builds)
account = $USER
```

Verified two ways: the
[x1 findings](../../docs/research/findings/x1-parallel-multi-account.md)
(live suffixed entry + binary read), and by `strings` inspection of the
shipping binary v2.1.193 (2026-07-04, read-only) which contains:

```js
function R1(e=""){let t=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  n=t!==void 0?!t:!process.env.CLAUDE_CONFIG_DIR,
  r=t!==void 0?t.normalize("NFC"):nr(),
  o=n?"":`-${createHash("sha256").update(r).digest("hex").substring(0,8)}`;
  return`Claude Code${Is().OAUTH_FILE_SUFFIX}${e}${o}`}   // e = "-credentials"
```

`OAUTH_FILE_SUFFIX` is empty in prod builds, so the base is
`Claude Code-credentials`. The derivation is **undocumented upstream** and can
change in any SDK bump — that is exactly what
[docs/runbooks/version-gate.md](../../docs/runbooks/version-gate.md) gates.
The base is parameterized everywhere (`AIBENDER_KEYCHAIN_SERVICE_BASE` /
`--service-base`) so a base change is a config edit, not a code change.

## Consumers

- `infra/scripts/accounts/provision-accounts.sh` — creates the dirs (0700).
- `infra/scripts/accounts/keychain-probe.sh` — presence probe, never `-w`.
- `infra/scripts/accounts/version-gate.sh` — pre-SDK-bump gate.
- BE-1 profile registry (plan §4/BE-1) — reads these manifests, labels only.
