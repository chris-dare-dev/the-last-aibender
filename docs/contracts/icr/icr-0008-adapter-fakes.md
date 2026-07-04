# ICR-0008 — Promote the BE-4 adapter fakes into @aibender/testkit

- Requesting lane: BE-D (BE-4 · backend adapters), via the BE-4 M2 return
- Surface: `packages/testkit`
- Freeze state at request time: n/a (testkit "grows continuously", plan §3)

## Motivation

Plan §3 names these as testkit deliverables outright: "mock OpenCode
/global/event SSE server (with evt_ ids, duplicate sync wrappers,
unknown-event injection, heartbeat), fake opencode.db builder, fake LM Studio
/api/v0". BE-4 implemented them locally under `core/src/adapters/testing/`
per the ICR-0001 precedent and flagged them for promotion. BE-5's collector
tests (M3) need exactly these fakes.

## Change (landed 2026-07-04)

Three modules moved into `packages/testkit/src/`:

- **`mockOpencodeServer.ts`** (`startMockOpencodeServer`) — real node:http on
  127.0.0.1, faithful to the probed v1.17.13 behavior
  (docs/research/findings/opencode-serve-event-probe.md): Basic-auth 401s,
  per-connection `server.connected`, monotonic `evt_synth…` ids, DOUBLE
  DELIVERY of durable events (plain + `type:"sync"` wrapper), heartbeat /
  unknown-event / raw injection, durable replay
  (`/api/session/{id}/event?after=`), forced disconnects, request recording.
- **`fakeLmStudio.ts`** (`startFakeLmStudioServer`) — `/v1/models`,
  `/v1/chat/completions` (records `ttl`, JIT-flips model state),
  `/api/v0/models` state reads, down-mid-request (`failNextChat('socket')`)
  and `setModelState` levers.
- **`fakeOpencodeDb.ts`** (`buildFakeOpencodeDb`, `SYNTHETIC_CREDENTIAL_VALUE`)
  — node:sqlite builder for the probed schema (`event`, `event_sequence`,
  `migration` head) plus deliberately present `account`/`credential` tables
  seeded with screamingly fake values, so the [X2] db-guard tests can prove
  those tables are unreadable through the guarded helper.

Zero `@aibender/*` dependencies (node:http + node:sqlite only); fixture
policy [X2] honored (all synthesized). A sanity suite
(`adapterFakes.spec.ts`) landed with the promotion; deep behavioral coverage
stays in the consuming core adapter suites.

## Compatibility

Move semantics, per the ICR-0001 landing record: `core/src/adapters/testing/`
was deleted and the eight consuming specs (four lmstudio, four opencode)
switched imports from `../testing/index.js` to `@aibender/testkit` in the
same change. Core's adapter suites stay green (proven by the run recorded in
the landing return).

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator: n/a (test-only surface; BE-5 consumes at M3)
