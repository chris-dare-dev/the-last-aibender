# infra/profiles/ — account profile manifests (SI-2, [X1] host side)

Machine-local path **conventions** for the provisioned Claude accounts, keyed by
sanctioned placeholder labels only. The label set is an **open, validated form**,
not a closed list (ICR-0013,
[icr-0013-account-registry.md](../../docs/contracts/icr/icr-0013-account-registry.md)):

- a **Max** account is `MAX_` + one uppercase letter A–Z (`^MAX_[A-Z]$`) —
  `MAX_A`, `MAX_B`, `MAX_C`, `MAX_D`, … `MAX_Z` are all first-class sanctioned
  placeholders, added **without a code change**;
- the **enterprise** account is the single literal `ENT`.

The fixed backend labels `AWS_DEV` / `LOCAL` are **not** Claude accounts and have
no manifest here. No real identity (emails, org/account UUIDs, AWS IDs) ever
appears here [X2]; the real mapping lives machine-locally per
[identity-map.example.json](identity-map.example.json). Adding an account is a
manifest-only change — see
[docs/runbooks/add-an-account.md](../../docs/runbooks/add-an-account.md).

Adding a whole new *backend* (a new local LLM / substrate beyond the built-in
three) is a different, code-side procedure — a `BackendDescriptor` +
`registerBackend`, with the backend declaring its **own** account-label form
(never a new `AWS_DEV`/`LOCAL`-style fixed label, which stays closed). See
[docs/runbooks/add-a-backend.md](../../docs/runbooks/add-a-backend.md)
(ICR-0016). Such a backend has no `*.profile.json` here.

Every consumer (`infra/scripts/accounts/*.sh`, the schema, the FE picker)
**enumerates the `*.profile.json` glob and validates the form** — nothing
hardcodes the count. The manifests shipped today are the seed registry
(MAX_A / MAX_B / MAX_C / MAX_D / ENT); a new one is picked up the moment it exists.

Sources of record: blueprint §3 ([X1] mechanism), plan §6/SI-2, ICR-0013,
[x1-parallel-multi-account](../../docs/research/findings/x1-parallel-multi-account.md).

## Files

| File | Purpose |
|---|---|
| `max-a.profile.json` / `max-b.profile.json` / `max-c.profile.json` / `max-d.profile.json` / `ent.profile.json` | One manifest per provisioned account label — dir convention, pinned env, keychain naming rule. `max-c` / `max-d` are the same shape as `max-a` / `max-b`; add more with the runbook above. |
| `identity-map.example.json` | Pointer only. The real label→identity map is `$AIBENDER_HOME/identity-map.json`, never committed. |

## Manifest schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "label": "MAX_A",                  // sanctioned FORM only: ^MAX_[A-Z]$ (a Max account) or ENT
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
