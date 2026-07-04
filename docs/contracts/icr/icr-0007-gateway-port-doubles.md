# ICR-0007 — Promote the gateway M2 port doubles into @aibender/testkit

- Requesting lane: BE-C (BE-3 · gateway), via the BE-3 M2 return
- Surface: `packages/testkit`
- Freeze state at request time: n/a (testkit "grows continuously", plan §3)

## Motivation

BE-3's M2 slice consumed the rest of the broker through the ports it declared
in `core/src/gateway/ports.ts` (`GatewayPtyHost`, `GatewayPtySession`,
`ApprovalBrokerPort`, `TranscriptSource`) and grew local doubles in
`core/src/gateway/fakePorts.ts` (deliberately unexported, same posture as
`fakeKernel.ts`). The BE-3 return asked for their promotion so FE-2 contract
suites can drive the exact doubles the gateway streaming suites see —
mirroring ICR-0002's FakeKernel promotion.

## Change (landed 2026-07-04)

`packages/testkit/src/fakeGatewayPorts.ts` exports:

- **`FakePtySession` / `FakePtyHost`** — the pty port doubles: write/resize/
  pause/resume recording, output/exit test levers, and the port contract's
  replay-live-sessions-synchronously announcement discipline.
- **`FakeApprovalBroker`** — in-memory pending table with the real broker's
  idempotence discipline (first decision applies + exactly one resolution;
  later decisions answer `not-pending`), plus `emitRequest`/`resolveWithout`
  levers for expiry/supersede scripting.
- **`FakeTranscriptSource`** — the kernel message-tap double.
- **Port-type structural mirrors** (`GatewayPtyHost`, `GatewayPtySession`,
  `ApprovalBrokerPort`, `ApprovalDecisionOutcome`, `TranscriptSource`,
  `Unsubscribe`) of `core/src/gateway/ports.ts` (the port of record) —
  ICR-0001 option (a) posture, same drift rule. Payload shapes ride the
  frozen `@aibender/protocol` wire types directly (no mirror).

## Compatibility

Move semantics: `core/src/gateway/fakePorts.ts` and its sanity spec were
deleted; the spec moved to testkit (`fakeGatewayPorts.spec.ts`) and the one
consuming core suite (`serverStreaming.spec.ts`) switched to
`@aibender/testkit` in the same change. `core/src/gateway/fakeKernel.ts`
remains gateway-local per ICR-0002's landing record (its migration onto the
testkit FakeKernel is still BE-3's follow-up, tracked there). No new testkit
dependencies; fixture policy [X2] honored.

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator: n/a (test-only surface; FE-2 consumes voluntarily)
