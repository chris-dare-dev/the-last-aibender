# ICR-0004 — Optional `prompt` on the frozen resume verb (+ launch-state M1 note)

- Requesting lane: BE-ORCH (fix wave, from the BE-3 handoff flag), implemented by the BE fix lane
- Surface: `packages/protocol` (control.ts, validate.ts) + `docs/contracts/ws-protocol.md` §4.1/§4.2 + golden corpus (`packages/testkit/wsGolden.ts`)
- Freeze state at request time: frozen at M1-CORE (2026-07-04)

## Motivation

The frozen M1 `resume` params carried only `{ sessionId, fork? }`, but the
BE-1 kernel's `SessionKernel.resume(sessionId, options)` requires
`options.prompt` to be a non-empty string on the sdk substrate — every resume
path (un-forked dead resume, fork, repair-fork) spawns an SDK `query()` that
must be handed the next user prompt (SDK 0.3.201 has no "resume without a new
prompt" mode). The frozen wire verb therefore could not drive the real kernel
at all: no gateway→kernel adapter could complete a wire-driven resume. BE-3
flagged this in its M1 handoff; it blocked the M1 scripted-demo wiring
(`composeBroker`) and FE-2's client work against the frozen surface.

Of the two options (add the field to the wire vs. make the kernel's prompt
optional), adding the field is the coherent one: an SDK resume without a new
user prompt is not meaningful at 0.3.201, so hiding the requirement inside the
kernel would just move the `bad-request` somewhere less explicable.

## Proposed change (landed)

1. **`ResumeRequest.params.prompt?: string`** (control.ts) — optional,
   non-empty when present (`validateControlRequest` enforces the non-empty
   rule; absence remains wire-valid).
2. **Substrate rule, broker-side:** the sdk substrate REQUIRES the prompt at
   M1 — the kernel adapter (core/src/main/) answers
   `bad-request: a prompt is required to resume an sdk session` when absent.
   The wire shape stays substrate-agnostic (a future pty resume may not need
   one).
3. **Gateway kernel port**: `KernelResumeParams.prompt?: string`
   (core/src/gateway/kernel.ts + the testkit structural mirror, per the
   ICR-0002 drift rule), threaded through `startGateway`'s resume dispatch.
4. **Golden fixtures** (ICR-0003 corpus): `control-resume-with-prompt`
   (valid) and `control-resume-blank-prompt` (`bad-request`) pin the shape
   for both departments.
5. **ws-protocol.md §4.1 M1 composition note** (folded into this ICR): the
   launch result's `state` reports the ledger state at response time. The M2
   broker loop answers `spawning`; the M1 `composeBroker` composition awaits
   the SDK spawn before answering, so `running`/`exited` are equally legal —
   clients must accept any registered `SessionState` (the validators always
   have).

## Compatibility

- **Additive and backward-compatible**: resume frames without `prompt`
  remain valid at the validator; sdk-substrate resumes without it now get a
  typed `bad-request` from the broker instead of being structurally
  unservable. No existing fixture changes verdict; two fixtures are added.
- Consumers today: BE-3 gateway (updated), `composeBroker` kernel adapter
  (new), testkit FakeKernel (updated — uses the prompt when present). FE-2
  does not exist yet; it builds against the amended surface from the start.
- `PROTOCOL_VERSION` stays `1.0.0-m1-core`: the string pins the freeze
  generation; amendments are tracked by the ICR ledger and the ws-protocol
  §9 amendment record, not by version churn before the M2 `1.0.0` bump.

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04** (decision directed in
  the M1 fix wave)
- Counterpart orchestrator (FE-ORCH): **pending co-sign** — FE lane not yet
  staffed at M1; co-sign required before FE-2 consumes the surface.
