# ICR-0001 — Promote BE-1 kernel test doubles into @aibender/testkit

- Requesting lane: BE-A (BE-1 · session kernel & account runtime)
- Surface: `packages/testkit`
- Freeze state at request time: pre-freeze (testkit "grows continuously", plan §3)

## Motivation

Plan §4/BE-1 requires the SDK client wrapped behind a `QueryRunner` interface
"so tests inject a FakeQueryRunner (contribute the fake to packages/testkit via
ICR if the steward has not provided one)". The steward had not provided one at
build time, so per the same clause both doubles were implemented locally under
`core/src/kernel/testing/` and are flagged here for promotion:

1. **`FakeQueryRunner`** (`core/src/kernel/testing/fakeQueryRunner.ts`) —
   deterministic scripted QueryRunner: records every `start()` spec (env
   snapshots feed the [X1] isolation assertions), `onStart` hook (the
   row-before-spawn ordering proof), auto/manual completion modes, spawn
   failure injection, abort integration. BE-3's control-verb tests and BE-2's
   pty-session tests will want the same fake.
2. **`synthesizedTranscript`** (`core/src/kernel/testing/transcriptFixtures.ts`)
   — synthesized JSONL transcript-tail generator covering tool_use/tool_result
   pairing, dangling calls, torn tails (SPIKE-D finding 3), and malformed
   interior lines. Complements testkit's `synthesizedJsonlLine` (which it
   reuses for plain turns). BE-5's JSONL tailer tests need exactly these
   shapes plus rotation variants.

## Proposed change

Move both modules into `packages/testkit/src/` (e.g. `fakeQueryRunner.ts`,
`transcriptFixtures.ts`) and export from the testkit index. The `QueryRunner`
type they implement lives in `core/src/kernel/queryRunner.ts`; either
(a) testkit declares a structurally-identical local type (zero-dep policy for
testkit consumers), or (b) the type moves to `packages/protocol`/a shared
location — steward's choice. `core/src/kernel/testing/` then re-exports from
testkit for one milestone and is deleted.

Fixture policy [X2] is already honored: all fixtures synthesized, placeholder
accounts only (reuses testkit's `PLACEHOLDER_ACCOUNTS` screen for text turns;
tool ids are `synthtool-<n>`, uuids `synthmsg-<n>`).

## Compatibility

Consumers today: `core/src/kernel/*.spec.ts`, `core/src/main/index.spec.ts`.
No frozen surface changes; testkit is additive. After promotion, core's specs
switch imports from `./testing/...` to `@aibender/testkit` (already a core
devDependency).

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator: n/a (test-only surface)

## Landing record (BE-ORCH, 2026-07-04)

- Both modules moved into `packages/testkit/src/` (`fakeQueryRunner.ts`,
  `transcriptFixtures.ts`) and exported from the testkit index; the
  transcript-fixture spec moved with them.
- **Type placement: option (a).** Testkit declares a structurally-identical
  mirror of the QueryRunner seam (`packages/testkit/src/queryRunner.ts`);
  `core/src/kernel/queryRunner.ts` remains the seam of record. Drift rule: a
  seam change lands in both files in the same ICR — divergence fails the
  kernel suites at typecheck time.
- **Deviation from the proposal:** the "re-export for one milestone" shim was
  skipped — `core/src/kernel/testing/` was deleted and core's three consuming
  specs switched to `@aibender/testkit` in the same change (move semantics per
  the steward brief; core stays green, proven by its suite).
- Unification with the gateway-side double landed as ICR-0002.

## Drift-rule application (BE-ORCH, 2026-07-04, post-M2 build)

BE-2's M2 approvals work added the in-loop permission relay to the seam of
record (`core/src/kernel/queryRunner.ts`): `CanUseToolContext`,
`CanUseToolResult`, `CanUseToolHandler`, and the optional
`QuerySpec.canUseTool`. Per the drift rule above, the same shapes now exist in
testkit's mirror (`packages/testkit/src/queryRunner.ts`, exported from the
index). Runtime behavior was already compatible (optional property + method
bivariance); only the mirror text lagged. The interim
`as unknown as QuerySpec` casts in `core/src/kernel/approvals.spec.ts` were
removed with the sync (sanctioned call-site adjustment).
