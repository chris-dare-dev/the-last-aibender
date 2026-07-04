# docs/contracts/icr/ — interface change requests

The only way a frozen shared surface (`packages/protocol`, `packages/schema`,
any doc in `docs/contracts/`) changes after its freeze milestone (plan §1.1).

**Process:**

1. An implementer writes a short markdown proposal here:
   `icr-NNNN-<slug>.md` (NNNN zero-padded, monotonically increasing).
2. The **owning orchestrator** (BE-ORCH for protocol/schema) reviews and lands
   the change itself — implementers never commit to the owned surface.
3. If another department consumes the surface, the **counterpart orchestrator
   co-signs** before landing (e.g. FE-ORCH for protocol changes).

**Template:**

```markdown
# ICR-NNNN — <one-line summary>

- Requesting lane: <BE-x / FE-x / SI-x>
- Surface: <packages/protocol | packages/schema | docs/contracts/<doc>>
- Freeze state at request time: <pre-freeze | frozen at Mn>

## Motivation
<why the current surface is insufficient — cite the work package>

## Proposed change
<exact types / DDL / prose delta>

## Compatibility
<who consumes this today; migration/rollout notes>

## Sign-off
- Owning orchestrator: <pending/landed>
- Counterpart orchestrator: <n/a | pending/co-signed>
```

## Landed

| ICR | Summary | Landed |
|---|---|---|
| [ICR-0001](icr-0001-kernel-test-doubles.md) | FakeQueryRunner + transcript fixtures promoted from core into `@aibender/testkit` | 2026-07-04 |
| [ICR-0002](icr-0002-gateway-kernel-double.md) | Unified gateway `FakeKernel` double over the canonical FakeQueryRunner | 2026-07-04 |
| [ICR-0003](icr-0003-ws-golden-corpus.md) | Golden WS-protocol fixture corpus (`GOLDEN_WS_FIXTURES`) in testkit | 2026-07-04 |
| [ICR-0004](icr-0004-resume-prompt.md) | Optional `prompt` on the frozen resume verb (+ launch-state M1 note); FE-ORCH co-sign **pending** | 2026-07-04 |
| [ICR-0005](icr-0005-pid-liveness-guard.md) | sqlite-ddl §4 prose: kernel pid-liveness guard proving child death before un-forked dead-resume of `running` rows | 2026-07-04 |
| [ICR-0006](icr-0006-pty-test-doubles.md) | BE-2 pty doubles (FakePtyBackend + synthetic login TUI) promoted into `@aibender/testkit` | 2026-07-04 |
| [ICR-0007](icr-0007-gateway-port-doubles.md) | Gateway M2 port doubles (FakePtyHost/FakePtySession/FakeApprovalBroker/FakeTranscriptSource) promoted into `@aibender/testkit` | 2026-07-04 |
| [ICR-0008](icr-0008-adapter-fakes.md) | BE-4 adapter fakes (mock OpenCode SSE server, fake LM Studio, fake opencode.db builder) promoted into `@aibender/testkit` | 2026-07-04 |
| [ICR-0009](icr-0009-kernel-message-tap.md) | Kernel message tap + raw-message retention — the BE-1 transcript-tee seam that unblocks composeBroker's transcript wiring (testkit mirror synced per the ICR-0001 drift rule) | 2026-07-04 |
| [ICR-0010](icr-0010-collector-fixture-feeds.md) | BE-5 collector fixture feeds promoted into `@aibender/testkit`: fake statusline stdin feed (payload generator + tee writer) + fake OTLP http/json emitter — closes the plan §3 "still to come" list | 2026-07-04 |

Post-M2 stewarding also landed (no new ICR numbers): the ICR-0001 drift-rule
sync (`canUseTool` on testkit's QuerySpec mirror — recorded in ICR-0001's
landing record), the ws-protocol §6 attach-semantics prose pin (recorded in
that doc's amendment table), and the `--port 0 = default 4096` correction on
`docs/research/findings/opencode-serve-event-probe.md` §1.

**Post-M3 stewarding (BE-ORCH, 2026-07-04 — no new ICR numbers, non-frozen
surfaces or prose pins recorded in the owning docs):**

- **ws-protocol §12 session-id relay pin** (prose only): harness-id-where-
  known with native-id relay until the BE-7/M4 ledger mapping; composition
  MUST inject the ledger resolver at M4 (recorded in that doc's amendment
  table). No BE-6 code change — `resolveSessionId` was built injectable.
- **sqlite-ddl §7.4 usage-data mapping pin** (prose only): facets →
  `session_outcomes`; session-meta → `events` (`event_type 'session_meta'`),
  never mirrored (recorded in that doc's amendment table).
- **BE-5→BE-6 watcher seam BLESSED in place**: `WatcherTouch` +
  `GraphFeed.ingestWatcherTouch`/`ingestHookPost`
  (core/src/collector/graphfeed/feed.ts) are the watcher event surface; the
  port type stays with the feed (no relocation into core/src/main/).
- **BE-4 SSE sync correlation landed** (non-frozen internal surface, the
  BE-5 return's hardening request): `OpencodeSseTransport.onSync` fans the
  `evt_` id ↔ durable (aggregate, seq) correlation out at parse time;
  the collector's SSE source consumes it to mark slots healed in either
  twin-arrival order — closing the documented one-chunk at-least-once window
  within a process lifetime (core/src/adapters/opencode/sse.ts,
  core/src/collector/opencode/sseSource.ts, tests in both suites).
- **FE composition activated**: `registerObservability(client)` wired into
  `app/src/main.tsx`; `CHANNEL.EVENTS` joined the GatewayClient
  `replayFromZeroOnFirstConnect` default so retained read-model snapshots
  hydrate dashboards on the first connect of a broker boot (ws-protocol §8
  below-floor answers stay the documented harmless case).
- **`.gitleaks.toml` rule-1 allowlist RATIFIED**: the `\b0{12}\b`
  (all-zeros) match-target allowlist on `aws-account-id-in-context` stands —
  the SI-4 brief mandates the syntactically-valid all-zeros placeholder;
  non-zero 12-digit literals still fail, and the SI-4 bats hygiene tests
  enforce the same invariant independently (see SECURITY.md §2 tuning log).
- **SI-4 suite wired into the composite**: root `test:infra` gained
  `infra/aws/tests/run.sh` (offline-safe self-skips) and ci.yml's
  infra-tests job runs it after a credential-less
  `terraform init -backend=false` (provider download only, never plan/apply).
- **Deferred, not landed** (plan §3 FYI): a seeded-events-store fixture
  builder in testkit — would add an `@aibender/schema` dependency to testkit
  for one consumer today (BE-6 specs seed `openEventsStore(':memory:')`
  inline, trivially migratable); revisit when a second consumer (FE golden
  store fixtures) materializes.

## Deferred watch items (BE-ORCH)

- ~~**`events` payload union (M3)**~~ **RESOLVED at the M3 freeze
  (2026-07-04):** the union froze with BE-5's events store — `event-summary`
  + `read-model-snapshot` + the frozen forward-tolerant unknown-kind rule
  (ws-protocol.md §13; protocol `1.1.0` / `FROZEN-M3`; corpus + hooks corpus
  extended in testkit). Client payloads on `events` (other than
  `replay-request`) still answer `bad-request`.
- **hooks-contract gating response (T3)**: the CLI-side interpretation of
  http-hook `200` bodies (`permissionDecision`) must be verified on the real
  host at SI-3 install before the hook floor turns enforcing
  (hooks-contract.md §4). Acceptance-side TYPES are frozen either way
  (hooks-contract.md §7, M3).

- **`extraArgs` on the wire**: protocol `LaunchParams` deliberately has NO
  `extraArgs` field. The kernel/runner already refuse `--bare` and screen
  extra argv defensively (`assertNoForbiddenArgs`); if extraArgs are ever
  exposed on the control surface, that is a protocol ICR (new frozen field +
  validator + golden fixtures), not a kernel-side patch.
- **`isKernelVerbError` structural check** (ICR-0002 follow-up, BE-3): core's
  guard is `instanceof`; loosening it to the structural shape lets testkit's
  `FakeKernel` drive the real gateway server without injecting core's error
  class.
- ~~**M2 composition integration (core/src/main, BE-MAIN — from the BE-3 M2
  return)**~~ **RESOLVED at the M3 build (2026-07-04, BE-MAIN):**
  `composeBroker` now wires EVERY gateway port through one composition —
  kernel verbs, the shared ApprovalBroker (kernel half via
  `approvalRelayFromBroker`, gateway half via
  `toApprovalBrokerGatewayPort`), the BE-2 ptyHost over the same
  ledger/profiles (`toGatewayPtyHostPort`), the ICR-0009 transcript tee
  (`messageTap` → `TranscriptSource` with `rawOfRunnerMessage`), and the M3
  `BrokerPublisherStarter` seam. Proven by
  `core/src/main/composedBroker.spec.ts` (launch→pty→approval→transcript
  over one socket) and the composed-mode soak. Remaining for BE-MAIN at M4:
  the DEFAULT publisher set once the operator-config slice exists (see the
  seam-status note at the `BrokerPublisherStarter` doc).
- **BE-8 session-create body (from the BE-4 M2 return):**
  `@opencode-ai/sdk@1.17.13`'s typed `SessionCreateData` body carries only
  `{parentID, title}` — the probe's `{agent, model, metadata, permission}`
  claim is not represented in this SDK generation. BE-4's session client
  stays on the typed surface; per-session model selection at create time
  needs an SDK bump or a widened body cast when BE-8's account routing lands.
- **SPIKE-A telemetry sink (FE, when the FE telemetry surface exists):**
  `attachRenderer` emits one `{mode, reason, detail?}` event per renderer
  selection/fallback via `onTelemetry` (spike-a clause 7) — route these to
  the collector as env telemetry (identifier-free [X2]); currently only
  captured by tests.
