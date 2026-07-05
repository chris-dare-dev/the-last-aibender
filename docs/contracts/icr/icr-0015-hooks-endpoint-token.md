# ICR-0015 — Hooks endpoint per-install token gate (SEC-3)

- Requesting lane: SI-3 (installer/templates) + BE-5 (collector), Stage-3
  security follow-up
- Surface: `docs/contracts/hooks-contract.md` §2 (acceptance table), §4
  (→ §4.1/§4.2), §5 (template obligations) — prose only; no `packages/protocol`
  / `packages/schema` type change (the acceptance-side types in §7/§7.1 are
  unchanged)
- Freeze state at request time: frozen at M2 (contract), acceptance types
  frozen at M3/M4 — all unaffected

## Motivation

The accepting hooks endpoint binds loopback (`127.0.0.1`) and, through M2–M6,
accepts any well-formed POST. Loopback stops off-host traffic but not other
**local** processes: any process on the box (a malicious npm dep, a browser
extension, a compromised sibling) can reach `127.0.0.1:<hooksPort>` and POST
forged `PermissionRequest`/`SessionEnd`/`PreCompact` events straight into the
approval floor and the session ledger. The Stage-3 review (SEC-3) flagged this
local-process spoofing gap. The original write-up framed the mitigation around
network exposure / firewalling; the real threat model is local spoofing, and
the loopback bind is retained — so the framing is corrected here.

## Proposed change

Prose-only, documenting an already-implemented **OPTIONAL, off-by-default**
token gate. No REQUEST-shape or type change.

1. **§4.2 (new)** — endpoint authentication. `HooksServerOptions.authToken`
   (collector, `core/src/collector/hooks/server.ts`): when set, every POST must
   carry the token in the `x-aibender-hook-token` header (`HOOK_TOKEN_HEADER`,
   constant-time compared) or is rejected **`401` before any body parse /
   normalize / events-store insert / approval-floor relay** — the 401 precedes
   even the 404 label check, so a token-less caller gets no path/label oracle.
   ABSENT `authToken` preserves the exact M2–M6 open behavior (the guard is a
   no-op). The token is a **stable per-install secret** (32-byte base64url) at
   `$AIBENDER_HOME/hook-token` (0600), minted once by SI-3 and READ by the
   broker at boot for `authToken` — **not** minted per boot (a per-boot value
   could never match the header baked into on-disk `settings.json`), and kept
   distinct from the per-boot WS gateway token.
2. **§2 acceptance table** — a `401` row (auth configured + header
   missing/repeated/mismatched), noted as preceding the 404 label check and
   absent when auth is unconfigured (the default). Existing rows cross-ref the
   renumbered §4.1.
3. **§4 → §4.1/§4.2** — the existing gating prose becomes §4.1; §4.2 is the
   auth gate. `§4` (the section) is unchanged as a reference target.
4. **§5.5 (new)** — the SI-3 template obligation: under `install --hook-token`,
   the header rides every loopback hook entry, value from the shared per-install
   secret; OFF by default; same loopback POST (no new transport/shell-out,
   §5.3); one shared secret across accounts (per-account delta stays
   `<LABEL>`-only, §1); removed on uninstall (secret file only on
   `--purge-shared`).
5. **New T3 verification item** — whether the pinned CLI forwards a custom
   request header on a `type:"http"` hook (and does not reject the unknown
   `headers` key) is UNVERIFIED, the same class as the §4.1 gating and §7.1
   injection CLI-response items. `authToken` and the SI-3 header injection stay
   OFF until that proof lands on the real host
   (`docs/runbooks/hooks-telemetry.md`).

## Compatibility

- **Default install and default compose are byte-identical to today.** The gate
  is opt-in on both sides (collector `authToken` absent; installer `--hook-token`
  off), so every existing green suite is unaffected — collector SEC-3 spec green
  (`core/src/collector/hooks/hooks.spec.ts`), SI-3 hooks bats green
  (`infra/hooks/tests`, 37/37 incl. the 10 SEC-3 cases).
- **Consumers.** BE-5 collector implements the gate (landed). SI-3
  installer/templates implement the header injection + the token file (landed,
  opt-in). BE-MAIN (composeBroker) is the remaining wiring: read
  `$AIBENDER_HOME/hook-token` at boot and pass it as `authToken` when the hooks
  endpoint is composed — that lane is not yet wired and lands with the endpoint.
- **Rollout is T3-gated.** Turning the gate on in production is blocked on the
  pinned-CLI header-forwarding proof above; until then the endpoint keeps its
  open, loopback-only posture.

## Sign-off

- Owning orchestrator (BE-ORCH): **PENDING** — this ICR proposes the frozen-doc
  amendment; BE-ORCH ratifies/lands per the freeze process.
- Counterpart orchestrator (SI-ORCH): **PENDING co-sign** — SI-3 authors the
  header-injecting templates/installer that must POST exactly this header; the
  co-sign confirms the installed shape matches §4.2/§5.5.
