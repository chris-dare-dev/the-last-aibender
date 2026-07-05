# ICR-0014 — FE-facing configured-account-registry surface (broker → cockpit)

- Requesting lane: **FE (Stage-3 account-registry generalization, lane FE)**
- Surface: `docs/contracts/bootstrap-file.md` (the FE discovery contract) and/or
  a `system`/discovery wire frame in `docs/contracts/ws-protocol.md` — whichever
  the broker owner (BE-ORCH) prefers as the carrier. This ICR does NOT touch
  `packages/protocol` types unilaterally; it asks the owning orchestrator to
  choose and land the carrier.
- Freeze state at request time: post-M7 (ICR-0013 landed the open account-label
  FORM in `vocab.ts`).

## Motivation

ICR-0013 widened the account-label validation to an OPEN form and made
`backendForLabel()` a function so `MAX_C`/`MAX_D`/… validate WITHOUT a code
change. Its FE follow-up (this lane) is: the cockpit picker and the channel
instrument panels must ENUMERATE the accounts actually provisioned on this
machine — the accounts the broker discovered from `infra/profiles/*.profile.json`
(BE-core task #222) — instead of a hardcoded five.

The FE cannot read `infra/profiles/*.profile.json` itself: it runs in the
WKWebView bundle (no fs, no Node), and the profile files carry machine-local
paths/env/keychain conventions the FE must never render ([X2]). The FE needs
just the **placeholder LABEL LIST** of configured Claude accounts, surfaced by
the broker over the existing discovery/wire channel.

Today the FE-facing bootstrap surface (`docs/contracts/bootstrap-file.md`,
`GatewayBootstrap = {port, token, pid, startedAt}`) carries NO account
information, and no wire frame advertises the configured set. So there is no
seam by which the cockpit can learn "this machine has MAX_A, MAX_B, ENT, MAX_C,
MAX_D".

## Carrier decision (BE-ORCH, 2026-07-05)

**Chosen: Option 1 — the bootstrap-file `claudeAccounts: string[]` field.**
Rationale: the FE needs the account set BEFORE it renders the launch picker /
channel panels, which happens before the first WS connect — a cold-start,
pre-connect surface is exactly what the bootstrap file already is. The field is
purely additive (the reader's "absent/malformed ⇒ ignore" discipline already
covers a missing field), so no wire SHAPE changes and no protocol version bump
is required. Option 2 (a discovery wire frame) is rejected as heavier without a
real requirement: the configured set is fixed for a broker boot, and a broker
restart already re-writes the bootstrap file, so "change the set without a
restart" is not a live need. Landed in `docs/contracts/bootstrap-file.md`
(§2 shape + field table, §3.6 write-side [X2] sanitize, §4.6 read-side [X2]
FORM filter, §6 amendment record).

## Proposed change

Surface the **configured Claude-account label list** to the FE. Two options for
the owning orchestrator to pick from (BE-ORCH chose Option 1 — see above):

1. **Bootstrap-file field (preferred — cold-start, pre-connect).** Add an
   OPTIONAL `claudeAccounts: string[]` to the bootstrap file
   (`docs/contracts/bootstrap-file.md`). The broker writes the placeholder
   labels of the accounts it discovered. The FE reader validates each element
   via `isClaudeAccountLabel` and DROPS non-form entries (fail-closed [X2]).
   Absent/empty ⇒ the FE falls back to its seed set. This is a pure additive
   field — the boot-identity triple and every existing reader rule are
   unchanged.

2. **Discovery wire frame.** A `system`/`registry` snapshot frame on connect
   carrying the same label list, replayed-from-zero like the other read
   models. Heavier, but lets the set change without a broker restart.

Either carrier must obey [X2]: it advertises ONLY sanctioned placeholder labels
(the `MAX_<X>`/`ENT` form), NEVER a real email/name/id and NEVER the
machine-local paths from the profile files.

## Compatibility

- Additive: no existing FE reader or wire frame changes shape. The bootstrap
  reader's "absent/malformed ⇒ ignore" discipline already covers the missing
  field.
- Consumers: the FE `accountRegistry` seam (`app/src/lib/accountRegistry.ts`,
  this lane) is the single consumer. It is BUILT to accept an injected list via
  `setConfiguredClaudeAccounts(...)` and to fall back to the seed three when
  none is supplied — so the FE lands NOW against the interim (below), and the
  broker surface drops in with a one-line composition-root wiring change and no
  FE-render change.

## Interim (documented, in effect until this lands)

Until the broker carrier lands, the FE composition root
(`app/src/main.tsx`) may call
`setConfiguredClaudeAccounts(<labels>)` once at boot with a locally-configured
list (e.g. read from a dev shim / the Tauri side), and the registry otherwise
falls back to `SEED_CLAUDE_ACCOUNTS = [MAX_A, MAX_B, ENT]`. The picker, panels,
and decks already render whatever N the registry returns — the interim exercises
the exact N-account code path (3-, 4-, 5-Claude registries are covered by the FE
test suite), so nothing about the render changes when the real surface arrives.

## Sign-off

- Owning orchestrator (BE-ORCH, broker/bootstrap owner): **RATIFIED 2026-07-05.**
  Carrier chosen = the optional bootstrap-file `claudeAccounts` field (see the
  carrier-decision section). Landed:
  - `core/src/gateway/bootstrap.ts` — `GatewayBootstrap.claudeAccounts?`,
    `isGatewayBootstrap` validates array-of-strings, `writeBootstrapFile`
    sanitizes fail-closed via the new `sanitizeClaudeAccountsForBootstrap`,
    `readBootstrapFile` preserves + re-sanitizes; barrel re-export in
    `core/src/gateway/index.ts`.
  - `core/src/gateway/server.ts` — `GatewayOptions.claudeAccounts` threaded into
    the write; `core/src/main/index.ts` — `composeBroker` passes
    `accountRegistry.labels()` (the accounts discovered from
    `infra/profiles/*.profile.json`).
  - Tests: `core/src/gateway/bootstrap.spec.ts` (carrier round-trip, fail-closed
    sanitize, back-compat, boot-identity-unaffected, read-side re-sanitize) and
    `core/src/main/index.spec.ts` (composition advertises the discovered labels;
    empty registry omits the field, no path/identity in the body).
  - The [X2] doctrine already generalizes the placeholder form to `MAX_<X>`
    (SECURITY.md §1, .gitleaks.toml header, landed with ICR-0013), which the
    carrier reuses verbatim — no gitleaks rule change (a `MAX_<X>` label is not
    secret-shaped).
- Counterpart orchestrator (FE-ORCH): **co-signed 2026-07-05.** The FE reader +
  composition-root wiring land in the same change: `app/src/lib/bootstrap.ts`
  adds `GatewayBootstrap.claudeAccounts?`, validates it in `isGatewayBootstrap`,
  and exposes `configuredClaudeAccountsFromBootstrap` (read-side [X2] FORM
  filter, dropping every non-form label); `app/src/main.tsx` reads it ONCE at
  boot (pre-render) and feeds `setConfiguredClaudeAccounts`, with the browser
  `window.AIBENDER_CLAUDE_ACCOUNTS` dev shim as a fallback and the seed set as
  the final fallback. The FE registry seam + its 3/4/5-Claude N-account
  rendering (already landed by the FE lane) consume it with no render change.
  Verified by `app/src/lib/bootstrap.spec.ts`. The documented interim is now
  superseded by the real carrier.
