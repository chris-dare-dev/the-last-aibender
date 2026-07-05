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
| [ICR-0011](icr-0011-gateway-workstream-slice.md) | M4 workstream-channel seams: gateway `WorkstreamEnginePort` + validated merge routing/`publishWorkstream` (absent-engine degrade) and the FE inbound-router workstream branch — landed by the M4 freeze agent so its own golden corpus replays green on both CI halves (ICR-0009 precedent); FE-ORCH co-sign **pending** | 2026-07-04 |
| [ICR-0012](icr-0012-gateway-pipeline-slice.md) | M5 pipelines-channel seam: gateway `PipelineEnginePort` + validated verb delegation/`publishPipeline` (absent-engine `pipeline-not-found` degrade, §18.4 error mapping incl. pipeline-invalid→validation-result+generic error) — replaces the M5-freeze stub, landed by the BE-8 build lane (ICR-0011 precedent); **BE-ORCH RATIFIED 2026-07-05**; FE-ORCH co-sign **pending** (no FE change bundled — the inbound router already flows `pipelines` frames forward-tolerantly; flip at the M5 gate) | 2026-07-05 |
| [ICR-0013](icr-0013-account-registry.md) | **AMENDS FROZEN-M1-CORE `vocab.ts` ([X1] scalability).** The account-label CLOSED 5-set becomes an OPEN validated FORM (`^MAX_[A-Z]$` Max accounts + exact `ENT` + the closed fixed backend labels AWS_DEV/LOCAL); `isAccountLabel` keys off the form; `LABEL_BACKENDS` Record → `backendForLabel()` function (pairing invariant preserved). Schema CHECKs relaxed via migrations 0005 (kernel) / 0006 (events); [X2] Max-placeholder doctrine generalized (MAX_C/MAX_D first-class). Validation-widening minor: `1.4.0`→`1.5.0`, `FROZEN-M6`→`FROZEN-M7`. **BE-ORCH RATIFIED 2026-07-05; FE-ORCH co-signed 2026-07-05** (the FE picker + channel panels enumerate the runtime registry — `app/src/lib/accountRegistry.ts` + 3/4/5-Claude render proven by the FE suite; the runtime set arrives via the ICR-0014 bootstrap carrier). | 2026-07-05 |
| [ICR-0014](icr-0014-fe-account-registry-surface.md) | **FE follow-up to ICR-0013.** Surfaces the CONFIGURED Claude-account label list to the cockpit so the FE picker + channel panels enumerate the runtime registry, not a hardcoded five. **Carrier chosen (BE-ORCH): the OPTIONAL bootstrap-file `claudeAccounts: string[]` field** (cold-start/pre-connect, purely additive, no protocol bump; the discovery-wire-frame option was rejected as heavier without a live need). Broker writes the labels `accountRegistry.labels()` discovered from `infra/profiles/*.profile.json`, sanitized fail-closed [X2] (`sanitizeClaudeAccountsForBootstrap`); FE reads it once at boot (`configuredClaudeAccountsFromBootstrap`, read-side FORM filter) → `setConfiguredClaudeAccounts`. bootstrap-file.md §2/§3.6/§4.6/§6 amended; proven by `core/src/gateway/bootstrap.spec.ts`, `core/src/main/index.spec.ts`, `app/src/lib/bootstrap.spec.ts`. **BE-ORCH RATIFIED 2026-07-05; FE-ORCH co-signed 2026-07-05** (reader + composition-root wiring land in the same change; interim superseded). | 2026-07-05 |

| [ICR-0016](icr-0016-backend-registry.md) | **AMENDS FROZEN-M1-CORE `vocab.ts` BACKENDS + the schema backend CHECKs (finding OS-1, [X1] scalability).** The BACKEND twin of ICR-0013: the CLOSED 3-tuple `[claude_code, opencode, lmstudio]` becomes a `BackendDescriptor` (id, `servesLabel`, `sourceName`, `substrates`, `builtin`, optional adapter/probe keys) + a registry (`registerBackend` / `backendById` / `allBackends` / `unregisterBackend`), pre-populated with the three built-ins. `isBackend` tests registry membership; `backendForLabel` / `isAccountLabel` / `sourceForBackend` / `substrateLegalFor` resolve through the descriptors; `BACKENDS` stays a KNOWN/SEED list. `registerBackend` refuses a built-in id, a conflicting id, an overlapping `servesLabel`, an unknown substrate, or a malformed descriptor (a real gate). Schema `backend`/`source`/account/pairing/pty CHECKs relaxed to the app-layer-gated form via migrations **0007** (kernel) / **0008** (events) / **0009** (kernel `step_attempt.account` — the table 0007 skipped on the "no backend column" reasoning, whose account CHECK still pinned the built-in forms and refused a full pipeline RUN on a 4th-backend account at the journal write) — the CHECK cannot query the runtime registry, so the value set moves to the accessor (M3-events open-vocabulary precedent); built-in clauses stay CHECK-enforced (defense-in-depth). Validation-widening minor: `1.5.0`→`1.6.0`, `FROZEN-M7`→`FROZEN-M8`. Golden proof: unregistered/garbage-backend rejection fixtures (pure replay) + register→replay→unregister `SYNTHETIC_BACKEND_WS_FIXTURE`. **BE-ORCH RATIFIED 2026-07-05; FE-ORCH co-signed 2026-07-05** (the FE launch picker + observability/resource-health panels enumerate `allBackends()`; `app/src/lib/backendLabels.ts` derives the engraved label from the registry — byte-identical built-ins + `fourthBackendRender.spec.tsx` proven; the launch `wire.spec.ts` freeze literal advanced from `FROZEN-M7` to `=== PROTOCOL_FREEZE` — the ICR-0013→ICR-0014 shape). Change record: [../../runbooks/os1-backend-registry.md](../../runbooks/os1-backend-registry.md). | 2026-07-05 |
| [ICR-0015](icr-0015-hooks-endpoint-token.md) | **SEC-3 hooks endpoint token gate.** Documents the OPTIONAL, off-by-default per-install token on the accepting hooks endpoint: `HooksServerOptions.authToken` + the `x-aibender-hook-token` header, `401`-before-parse reject (precedes the 404 label check — no label oracle), a STABLE per-install secret (`$AIBENDER_HOME/hook-token`, SI-3-minted 0600, broker-read at boot) distinct from the per-boot WS gateway token, local-process-spoofing threat model with the loopback bind preserved (firewall framing dropped). `hooks-contract.md` §2/§4.1/§4.2/§5.5 amended; collector gate green (`hooks.spec.ts` SEC-3) + SI-3 header injection green (`infra/hooks` bats, opt-in `--hook-token`). New T3 item: pinned-CLI custom-header forwarding before `authToken` turns on. Prose-only — no `packages/protocol`/`packages/schema` type change. **BE-ORCH ratification PENDING; SI-ORCH co-sign PENDING.** | prose 2026-07-05 (sign-off pending) |

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

**Post-M4 build stewarding (BE-ORCH, 2026-07-04 — no new ICR numbers;
client-side implementations of already-frozen wire surfaces plus non-frozen
composition/chrome/infra wiring, recorded here per the post-M3 precedent):**

- **GatewayClient merge sender landed** (the FE-6 M4 return's ICR):
  `sendWorkstreamMergeRequest(request): boolean` on
  `app/src/lib/ws/wsClient.ts` — the exact `sendApprovalDecision` mirror for
  the frozen §16.2 client verb (rides the `workstream` channel; false when
  not connected — the unsendable posture, never a throw). FE-6's
  `WorkstreamMergeSender` port is now satisfied structurally by the real
  client (compile-pinned in `wsClient.spec.ts` without a lib→features
  import); `registerWorkstreams` detects it with no FE-6 change. No wire
  shape changed — this implements ws-protocol.md §16.2 as frozen.
- **`CHANNEL.WORKSTREAM` + `CHANNEL.CONTEXT_GRAPH` joined the
  `replayFromZeroOnFirstConnect` default** (the M3 events-channel precedent):
  the retained §16.5 list/detail snapshots hydrate the lineage view on the
  first connect of a broker boot, and the retained context-graph touch
  window warm-starts the graph island's activity read model after an app
  restart (bounded + honest — below-floor answers stay the documented
  harmless `watermark-out-of-range`, §8). Client behavior only; §8 already
  grants the client one replay-request per replayable channel.
- **FE composition activated for M4**: `registerGraphIsland(client)` (FE-4)
  and `registerWorkstreams(client)` (FE-6) wired into `app/src/main.tsx`
  beside the M3 `registerObservability` call — the graph island binds the
  context-graph channel per mount and rebuilds its scene on broker restart;
  the workstream binding + palette verbs register once at boot.
- **Chrome mount points landed (FE-ORCH ratification recorded here; co-sign
  rides the M4 gate review):** (a) the one-line additive `IslandSlot` union
  widening (`'workstreams'`) in `app/src/chrome/islandRegistry.ts` is
  RATIFIED (FE-6's change, the FE-5/observability M3 precedent — the
  registry seam is otherwise closed); (b) `WorkstreamsDock` mounts the
  `workstreams` slot in the LEFT zone below the fleet panel (DESIGN.md §4.1
  "left — fleet: workstream tree, session list"; the ObservabilityDock
  pattern verbatim, NO SIGNAL while empty); (c) the work surface gained the
  GRAPH view toggle (header affordance + `chrome.work.graph.toggle` palette
  verb, DESIGN.md §6 kill-switch rule) making the FE-4 `graph` slot
  reachable — the graph view is session-independent and mounts with a
  pinned `sessionId: undefined` context so selection changes never tear the
  scene down; token-lint clean, no new animation, no ADR needed (center
  zone is "active session (terminal/transcript), graph, builder" — §4.1).
- **SI-5 colima suite wired into the composite**: root `test:infra` gained
  `infra/colima/tests/run.sh` (headless — PATH stubs + a suite-owned
  loopback fake; never the real VM) and ci.yml's infra-tests job runs it as
  test:infra 5/5 (steps renumbered 1/5..5/5; python3 + curl are
  runner-native). The registry-coupled bats already pin the 13-row
  live-check registry (`REGISTRY_COUNT=13`).

**Post-M5 build stewarding (BE-ORCH, 2026-07-05 — no new ICR numbers;
client-side implementations of the already-frozen `pipelines` wire surface plus
non-frozen composition/chrome wiring, recorded here per the post-M4 precedent):**

- **ICR-0012 RATIFIED** (BE-ORCH): the gateway `PipelineEnginePort` +
  `publishPipeline` seam that the BE-8 build lane landed against the M5-freeze
  stub is reviewed and ratified — additive (one optional gateway option, one
  handle method, the port + its shapes on the barrel), absent-engine degrade
  preserved byte-for-byte, `serverPipelines.spec.ts` (10) +
  `composedPipelines.spec.ts` (2) green, full `serverGolden.spec.ts` corpus
  replays green. FE-ORCH co-sign stays pending (no FE change bundled; the
  inbound router already flows `pipelines` frames forward-tolerantly) — flipped
  at the M5 gate.
- **GatewayClient pipeline verb sender landed** (the FE-6 M5 return's ICR):
  `sendPipelineMessage(message: PipelineClientPayload): boolean` on
  `app/src/lib/ws/wsClient.ts` — the exact `sendApprovalDecision` /
  `sendWorkstreamMergeRequest` mirror for the six frozen §18.2 client verbs
  (rides the `pipelines` channel; ONE method carries all six, discriminated on
  `kind`; false when not connected — the unsendable posture, never a throw).
  FE-6's `PipelineVerbSender` port (`app/src/features/pipelines/ports.ts`) is
  now satisfied structurally by the real client (compile-pinned in
  `wsClient.spec.ts` without a lib→features import); `register.tsx senderOf()`
  detects it with no FE-6 change. No wire shape changed — this implements
  ws-protocol.md §18.2 as frozen.
- **`CHANNEL.PIPELINES` joined the `replayFromZeroOnFirstConnect` default**
  (the M3 events-channel / M4 workstream+context-graph precedent): the retained
  §18 catalog snapshot + run/step-status window hydrate the builder palette +
  run monitor on the first connect of a broker boot (the golden
  `pipelines-replay-request-valid` fixture). Client behavior only; §8 already
  grants one replay-request per replayable channel; below-floor answers stay
  the documented harmless `watermark-out-of-range`.
- **FE composition activated for M5**: `registerPipelines(client)` wired into
  `app/src/main.tsx` beside the M3 `registerObservability` / M4
  `registerGraphIsland` + `registerWorkstreams` calls — the pipelines binding
  (rAF projector) + island registration + "open pipelines" palette verb
  register once at boot; the six-verb sender is detected structurally on the
  client.
- **Chrome mount point landed (FE-ORCH ratification recorded here; co-sign
  rides the M5 gate review):** (a) the one-line additive `IslandSlot` union
  widening (`'pipelines'`) in `app/src/chrome/islandRegistry.ts` is RATIFIED
  (the M4 `'workstreams'`-slot precedent — the registry seam is otherwise
  closed); the FE-6 `register.tsx` `PIPELINES_SLOT` cast is now an exact-match
  no-op. (b) The `pipelines` slot mounts as the CENTER work-surface `builder`
  view (DESIGN.md §4.1 "Center — work: active session, graph, builder") — the
  FE-6 deck is one component holding both the builder canvas and the run-list /
  run monitor (an internal mode toggle), so it occupies the one center slot;
  it is session-independent and mounts with a pinned `sessionId: undefined`
  context so selection changes never tear it down (the graph-view precedent).
  (c) The work surface gained the BUILDER view toggle (header affordance +
  `chrome.work.pipelines.toggle` "toggle builder view" palette verb, DESIGN.md
  §6 kill-switch rule) making the slot reachable; token-lint clean, no new
  animation, no ADR needed (§4.1 already names "builder" as a center view).

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
- **FE-4 soak floor: WebKit pinned-pacing reading (M4 gate, 2026-07-04):**
  Playwright 1.61 headless WebKit pins rAF at a 60 Hz virtual vsync, making
  the spike-B p95 ≤ 16.7 ms encoding unpassable for ANY scene (the gate's
  cold 4-node control measured p95 18.0 ms, identical to the 5k hot run).
  The pw runner (`app/src/islands/graph/pw/run-pw.ts`) now detects a 60
  Hz-pinned engine and asserts the verdict's PRIMARY "60 fps sustained /
  30 fps hard floor" form (fps ≥ 58, <1% >33.3 ms, p95 within vsync
  jitter); the strict encoding still governs every >60 Hz engine. Full
  record: [m4-dod.md](../../runbooks/m4-dod.md) D1. Resolution: the T3
  in-Tauri soak (spike-B "what remains" #1) measures the strict floor under
  ProMotion/uncapped pacing — flip this item when that run lands.
- ~~**M4 freeze co-signs (open at the M4 gate)**~~ **FLIPPED at the M5 review
  (2026-07-05):** ws-protocol M4 row (§15/§16) + [ICR-0011](icr-0011-gateway-workstream-slice.md)
  — FE-ORCH; hooks-contract §7.1 [X4] routing row — SI-ORCH. Now **co-signed
  (M5 review)** (record: [m5-dod.md](../../runbooks/m5-dod.md) §6; the cited
  workstream golden-corpus + composedWorkstreams + hooks-bats proofs re-ran
  green at the M5 gate). The M2/M3-era rows were flipped at the M4 review.
- ~~**M5 freeze co-signs (open at the M5 gate)**~~ **FLIPPED at the M5 review
  (2026-07-05):** ws-protocol M5 row (§18) + [dag-schema.md](../dag-schema.md)
  v1 + sqlite-ddl §10 (schema 0004) + [ICR-0012](icr-0012-gateway-pipeline-slice.md)
  — FE-ORCH. Now **co-signed (M5 review)** (record:
  [m5-dod.md](../../runbooks/m5-dod.md) §6). The M5 wire additions are
  forward-tolerant on the FE inbound path (the launch wire spec pins
  `GOLDEN_WS_CORPUS_FREEZE === 'FROZEN-M5'`); the FE-6 pipelines deck + the
  client `sendPipelineMessage` / `PIPELINES` replay-from-zero / chrome
  `'pipelines'` slot consume them — the FE golden-corpus round-trip (114/114
  incl. every `pipelines` frame + verb) + `features/pipelines` (82/82) green.
- ~~**M6 freeze co-signs (open at the M6 gate)**~~ **FLIPPED at the M6 gate
  (2026-07-05) — see the FLIPPED record below:** ws-protocol M6 row (§13.4
  `resource-health`) + `integration-suite.md` (§9.3/§9.4 contract of record)
  — **FE-ORCH** (the FE resource/pressure instrument consuming `resource-health`
  under the §6.3-deck seam) and **BE-9/BE-6 producer lane** (the supervision
  governor produces the frame; `core/src/readmodels/publisher.spec.ts` narrows
  its `.toEqual([...READ_MODEL_IDS])` to the ten observability leads). The M6
  bump (`PROTOCOL_FREEZE = 'FROZEN-M6'`, `PROTOCOL_VERSION 1.4.0`) is landed
  green across the four BE-ORCH-stewarded packages (protocol 230, testkit 95,
  schema 94, shared 36); the downstream freeze-literal advances
  (`app/src/features/launch/wire.spec.ts`, `core/src/collector/hooks/hooks.spec.ts`)
  + the "ten leads" behavioral assertions
  (`app/src/features/observability/{golden,freshness}.spec.tsx`,
  `core/src/readmodels/publisher.spec.ts`) + the `Record<ReadModelId,…>` label
  maps (`app/.../ObservabilityDeck.tsx`, `core/.../publisher.ts`) advance with
  the consuming M6 agents (the M3/M4/M5 precedent — each freeze's downstream
  literal advanced in the consuming lane's commit, not the freeze commit).
- **M6 post-build ICRs — REVIEWED + LANDED by BE-ORCH at the M6 gate
  (2026-07-05):** the four freeze-forced/composition items the BE-9/SI-M6 build
  returned (BE-ORCH is their steward):
  1. **`core/src/readmodels/publisher.ts`** — the forced
     `'resource-health': ['lmstudio']` entry in the exhaustive
     `Record<ReadModelId, EventSource[]>` (the closed registry grew to 11 at the
     freeze). VERIFIED inert: BE-6's `snapshotAll()` emits exactly the ten §6.3
     leads; the BE-9 governor (`core/src/supervision/publisher.ts`) produces
     `resource-health` from its own `ResourceHealthSnapshot.sources` and never
     reads this default. Type-satisfaction + documentation only.
  2. **`core/src/readmodels/publisher.spec.ts:152`** — `.toEqual([...READ_MODEL_IDS])`
     → `.slice(0, 10)`. VERIFIED correct: `resource-health` is index 10 (the
     11th) in the frozen registry; the spec independently asserts
     `sink.events` length 10. Publisher behavior unchanged.
  3. **`core/src/collector/hooks/hooks.spec.ts:43,48`** — `'FROZEN-M5'` →
     `'FROZEN-M6'`. VERIFIED against the frozen constants
     (`PROTOCOL_FREEZE = 'FROZEN-M6'`, `GOLDEN_HOOK_CORPUS_FREEZE = 'FROZEN-M6'`,
     `PROTOCOL_VERSION 1.4.0`). A stale-marker advance, no behavior change.
  4. **`core/src/main/index.ts`** (BE-ORCH-owned composition root) — the
     `supervision` options block + `ComposedBroker.supervision` field +
     late-bound events sink + recycle bound to the ptyHost + close-path
     teardown. VERIFIED to mirror the M4 workstream / M5 pipeline slice pattern
     exactly (opt-in, late-bound sink nulled on close, `...(x !== undefined ? {}
     : {})` conditional spread). Proven end-to-end by
     `core/src/main/composedSupervision.spec.ts` (resource-health rides EVENTS
     to a real client with an [X2] no-leak assertion; a watchdog recycle records
     a `continue` edge with `reason: recycle` on the lineage store — the M6 DoD
     "one real recycle with lineage continuity"; [X1] red-pressure account spawn
     admitted post-shed; absent option → M1–M5 behavior). No frozen-contract
     surface touched; no separate contract amendment required (slice precedent).
- **M6 freeze co-signs — FLIPPED at the M6 review (2026-07-05):** the ws-protocol
  M6 row (§13.4 `resource-health`) + `integration-suite.md` co-signs above are
  **co-signed** at the M6 gate — the golden-corpus round-trip (both sides), the
  ten-lead behavioral assertions, and the composed supervision E2E all re-ran
  green (record: [m6-dod.md](../../runbooks/m6-dod.md)).
- **Still-open co-signs (long-standing, next window):** [ICR-0004](icr-0004-resume-prompt.md)
  resume-prompt (M1-era) + bootstrap-file.md M2 freeze row + icr-0003
  counterpart — all FE-ORCH.
