# ICR-0011 — gateway + FE-router workstream-channel seams (the M4 wire, compose-ready)

- Requesting lane: BE-ORCH (executed at the M4 contract freeze — the
  ICR-0009 precedent: the freeze agent lands the minimal cross-lane seams
  its own frozen surfaces require, recorded here)
- Surface: `core/src/gateway/ports.ts` (one new port type),
  `core/src/gateway/server.ts` (workstream routing + `publishWorkstream`),
  `core/src/gateway/serverWorkstream.spec.ts` (new),
  `core/src/gateway/index.ts` (one export),
  `core/src/collector/hooks/hooks.spec.ts` (freeze-literal advance),
  `app/src/lib/ws/inboundRouter.ts` (workstream branch),
  `app/src/features/launch/wire.spec.ts` (freeze-literal advance — the
  recorded M3 precedent)
- Freeze state at request time: gateway M2-frozen behavior; FE router
  M2/M3-frozen behavior; both must speak the M4 `workstream` channel

## Motivation

The M4 freeze registers the `workstream` channel with a CLIENT verb
(`workstream-merge-request`) and a broker→client payload union
(ws-protocol.md §16), and extends the golden corpus with those frames. The
corpus is replayed byte-for-byte by BOTH departments' CI against their REAL
stacks (`serverGolden.spec.ts` drives the live gateway;
`goldenCorpus.spec.ts` drives the FE inbound router). Without wiring:

1. the M2-era gateway answers a VALID merge request with the channel-policy
   `bad-request` — a VALIDATION code, so the corpus's valid fixture fails
   the live-gateway replay;
2. the FE router answers any workstream broker frame `unknown-channel` — the
   corpus's valid broker→client fixtures fail the FE replay.

A freeze whose own corpus breaks both CI halves is not a freeze. The seams
must land WITH it — exactly the ICR-0009 situation (the M3 freeze needed the
kernel message tap for composeBroker's transcript tee).

## Change (minimal, port-shaped, absent-by-default)

1. **`WorkstreamEnginePort`** (gateway ports.ts): `merge(request) →
   Promise<WorkstreamMergeResolved>`; typed rejections via the existing
   `KernelVerbError` (frozen merge codes: `session-not-found`,
   `workstream-not-found`, `bad-request`; others → GENERIC `internal`
   [X2]). BE-7 implements it over `core/src/workstreams/` at M4;
   composeBroker wires it.
2. **Gateway routing**: client payloads on `workstream` validate against
   the FROZEN `validateWorkstreamClientMessage`, then delegate to the port.
   ABSENT port → the runtime error `session-not-found` with
   `correlatesTo: mergeId` (no lineage engine composed = no session nodes;
   the approvals empty-broker degrade posture — every-port-optional rule
   preserved). Success fans out the defensively-revalidated
   `workstream-merge-resolved`.
3. **`publishWorkstream(payload)`** on the gateway handle: validated,
   journaled (replayable §8) broadcast — refuses invalid AND
   unregistered-kind payloads (forward tolerance is a READER rule). BE-7's
   fan-out source; the mirror of `publishQuota`/`publishContextTouch`.
4. **FE inbound router**: `workstream` branch through the FROZEN
   `validateWorkstreamServerPayload`; new `InboundMessage` kind
   `'workstream'` (opaque-tolerant payload union); `replayableChannelOf` /
   `seqOf` cover it. `wsClient` flows it to `onMessage` generically (its
   switch has a default) — FE-4/FE-6 stores consume from there at M4.
5. **Freeze-literal advances** (compile-enforced by
   `typeof PROTOCOL_FREEZE`): `core/src/collector/hooks/hooks.spec.ts` and
   `app/src/features/launch/wire.spec.ts` pin `FROZEN-M4`.

## Compatibility

- Additive: one optional gateway option, one handle method, one FE message
  kind; NO existing composition changes (`workstreams` stays absent
  everywhere until BE-7). All prior golden fixtures replay byte-identically.
- Verified: full workspace suites green including `serverGolden.spec.ts`
  (59 fixtures incl. the merge frames against the live gateway),
  `serverWorkstream.spec.ts` (8: engine round-trip fan-out, absent-engine
  degrade, KernelVerbError mapping, [X2] generic internal, publisher
  refusals, invalid-resolution drop, replay-from-0), and the FE
  `goldenCorpus.spec.ts` replay of every workstream frame.
- Reversal path: delete the port/option/branch + the M4 fixtures; nothing
  outside composeBroker (future) and these specs may depend on them.

## Sign-off

- Owning orchestrator (BE-ORCH): **landed** (2026-07-04, M4 freeze agent)
- Counterpart orchestrator (FE-ORCH): **co-signed (M5 review, 2026-07-05)** —
  the FE half is the `workstream` inbound-router branch
  (`app/src/lib/ws/inboundRouter.ts`, opaque-tolerant
  `validateWorkstreamServerPayload`, `replayableChannelOf`/`seqOf` coverage)
  plus the `wire.spec.ts` freeze literal (now `FROZEN-M5`, reached through
  `FROZEN-M4`); both replay green, and `app/src/lib/ws/goldenCorpus.spec.ts`
  round-trips every workstream frame against the real FE router.
