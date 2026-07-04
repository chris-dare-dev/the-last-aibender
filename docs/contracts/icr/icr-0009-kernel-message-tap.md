# ICR-0009 — kernel message tap + raw-message retention (the BE-1 transcript-tee seam)

- Requesting lane: BE-ORCH (resolving deferred watch item 1 — the M2
  composition blocker recorded from the BE-3 M2 return), executed at the M3
  contract freeze
- Surface: `core/src/kernel/queryRunner.ts` seam types (+ the
  `@aibender/testkit` structural mirror per the ICR-0001 drift rule),
  `core/src/kernel/sessionKernel.ts` (one new optional option),
  `core/src/kernel/sdkQueryRunner.ts` (message mapping)
- Freeze state at request time: the queryRunner seam is BE-1's M1 surface
  (kernel slice, frozen M1); testkit mirror frozen with it

## Motivation

`composeBroker` could not wire the gateway's `TranscriptSource` port
(transcript.<sid> tee) because of two properties of the M1 seam, recorded as
a deferred watch item at the M2 gate:

1. `QueryHandle.messages()` is **single-consumer** — the kernel's pump owns
   it. A composition-root wrapping QueryRunner would have to fan the stream
   out itself (backpressure/termination semantics leaking into composition).
2. The SDK runner **narrows** the terminal message: `RunnerResultMessage`
   drops `usage`/`total_cost_usd`, so even a wrapper tap could not feed
   `transcript-result` its frozen usage fields (ws-protocol.md §9).

## Decision (both halves, minimal and reversible)

1. **Raw-message retention:** `RunnerInitMessage` and `RunnerResultMessage`
   gain an OPTIONAL `raw?: unknown` carrying the verbatim SDK message
   (`RunnerOtherMessage.raw` already existed). `createSdkQueryRunner`
   populates it; fakes that don't script it stay valid (optional field —
   no existing test or consumer breaks). The kernel itself still reads only
   the narrow fields.
2. **Kernel message tap:** `SessionKernelOptions.messageTap?:
   RunnerMessageTap` — `(sessionId, message) => void`, invoked by the ONE
   pump for every message, per session, in stream order, on every spawn path
   (launch, fork, dead resume). It is a TAP, not a second consumer:
   `messages()` stays single-consumer and no fan-out semantics enter the
   runner seam. A throwing tap is logged and ignored — it can never stall or
   kill the pump or FSM settlement (tested). Absent → M1/M2 behavior
   exactly.
3. **Adapter helper:** `rawOfRunnerMessage(message)` returns the raw SDK
   value (`other` unwraps; init/result prefer retained raw, falling back to
   the narrowed message so bare fakes still project).

The composition root (BE-MAIN, this milestone) wires the tee as:

```ts
const taps = new Set<(sid: string, raw: unknown) => void>();
const kernel = createSessionKernel({
  ...,
  messageTap: (sid, m) => { for (const t of taps) t(sid, rawOfRunnerMessage(m)); },
});
const transcripts: TranscriptSource = { onMessage: (l) => { taps.add(l); return () => taps.delete(l); } };
```

The gateway's projector (`core/src/gateway/transcriptProjector.ts`) already
consumes raw SDK messages and unwraps `{type:'other'}` wrappers — no gateway
change needed.

## Compatibility

- Additive: `raw` is optional; `messageTap` is optional; no wire change, no
  protocol/schema change, no golden-fixture change.
- Consumers updated in this ICR (the drift rule): testkit mirror types +
  `FakeSession.complete({raw})` passthrough; two `toEqual` assertions on
  narrowed messages (`sdkQueryRunner.spec.ts`, BE-4's
  `claude-sdk/index.spec.ts`) now expect the retained raw.
- Reversal path: delete the tap option + `raw` fields; nothing outside the
  composition root and these specs may depend on them (the gateway depends
  only on its own `TranscriptSource` port).

## Sign-off

- Owning orchestrator (BE-ORCH): **landed** (2026-07-04, M3 freeze agent)
- Counterpart orchestrator: n/a on the wire; BE-1/BE-MAIN implementers
  consume via `core/src/kernel` exports (`RunnerMessageTap`,
  `rawOfRunnerMessage`)
