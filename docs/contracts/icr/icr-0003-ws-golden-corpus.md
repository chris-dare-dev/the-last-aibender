# ICR-0003 — Golden WS-protocol fixture corpus in @aibender/testkit

- Requesting lane: BE-C (BE-3 · gateway) via the BE-3 return; landed by BE-ORCH
- Surface: `packages/testkit` (exercises the FROZEN `packages/protocol` surface
  without amending it)
- Freeze state at request time: pre-freeze for testkit; the protocol it pins is
  FROZEN-M1-CORE (unchanged by this ICR)

## Motivation

Plan §3 (testkit row) and §9.3 BE↔FE #1 require "golden protocol fixtures from
`packages/testkit` replayed against both the FE client and BE gateway". The
gateway suite synthesized its own frames; FE-2 had no shared bytes to replay.

## Change (landed 2026-07-04)

`packages/testkit/src/wsGolden.ts` exports:

- **`GOLDEN_WS_FIXTURES`** — ~50 fixtures pinning EXACT wire frames:
  - text envelopes (the UTF-8 string sent as one WS text frame): all four
    frozen control verbs in valid minimal/full forms, control responses
    (ok results, error results), pushed error payloads, pty flow-control
    JSON (`pty-ack`/`pty-replay-request`/`pty-resize`);
  - negatives at every routing stage: non-JSON text, envelope violations
    (stream/channel mismatch, unknown channel, bad seq, missing payload),
    reserved/unknown verbs, field-level `bad-request`s (label/backend
    pairing, pty-substrate rule, relative cwd, malformed ids), pty session
    mismatch, M1 channel policy;
  - binary PTY frames as lowercase hex (`goldenFrameBytes` decodes):
    valid OUTPUT/INPUT frames with decoded-field pins + encoder round-trip,
    and codec rejections (bad magic/version/type, truncation, payload over
    the 1 MiB cap, length mismatch, zero-length sid).
  - Every fixture pins frame bytes + expected verdict (`valid` or the exact
    frozen `ErrorCode`) + the STAGE that must produce it.
- **`replayGoldenWsFixture`** — the reference replay: routes a fixture through
  the frozen `@aibender/protocol` validators in the gateway's routing order
  (json-parse → envelope → channel/direction-specific validator).
- The suite additionally asserts: full coverage of the CLOSED `ERROR_CODES`
  registry, unique fixture names, an exact-byte serialization pin, and an
  [X2] identity-shape screen over every frame.

## Compatibility

- Additive testkit export; `packages/protocol` is untouched (no amendment
  record needed in `docs/contracts/ws-protocol.md`).
- Per plan §9.3 BE↔FE #1, **a fixture change requires both orchestrators'
  sign-off** — treat `GOLDEN_WS_FIXTURES` as co-owned by BE-ORCH and FE-ORCH
  from this landing onward, even though testkit itself is pre-freeze.
- BE-3 and FE-2 may replay the raw frames through their own stacks; the bytes
  and verdicts are the contract, the replay helper is a convenience.

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator (FE-ORCH): pending co-sign for future fixture
  CHANGES (initial landing is additive and validator-derived)
