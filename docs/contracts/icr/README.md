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

Post-M2 stewarding also landed (no new ICR numbers): the ICR-0001 drift-rule
sync (`canUseTool` on testkit's QuerySpec mirror — recorded in ICR-0001's
landing record), the ws-protocol §6 attach-semantics prose pin (recorded in
that doc's amendment table), and the `--port 0 = default 4096` correction on
`docs/research/findings/opencode-serve-event-probe.md` §1.

## Deferred watch items (BE-ORCH)

- **`events` payload union (M3)**: the one surface left open by the M2 full
  freeze (ws-protocol.md §8 + amendment record). Freezes with BE-5's
  normalized events store; until then client payloads on `events` (other than
  `replay-request`) answer `bad-request` and broker pushes are opaque.
- **hooks-contract gating response (T3)**: the CLI-side interpretation of
  http-hook `200` bodies (`permissionDecision`) must be verified on the real
  host at SI-3 install before the hook floor turns enforcing
  (hooks-contract.md §4).

- **`extraArgs` on the wire**: protocol `LaunchParams` deliberately has NO
  `extraArgs` field. The kernel/runner already refuse `--bare` and screen
  extra argv defensively (`assertNoForbiddenArgs`); if extraArgs are ever
  exposed on the control surface, that is a protocol ICR (new frozen field +
  validator + golden fixtures), not a kernel-side patch.
- **`isKernelVerbError` structural check** (ICR-0002 follow-up, BE-3): core's
  guard is `instanceof`; loosening it to the structural shape lets testkit's
  `FakeKernel` drive the real gateway server without injecting core's error
  class.
- **M2 composition integration (core/src/main, BE-ORCH — from the BE-3 M2
  return):** wire `startGateway`'s M2 ports at the composition root. The
  pty/approvals halves are ready-made (BE-2's `toGatewayPtyHostPort` /
  `toApprovalBrokerGatewayPort` in `core/src/kernel/pty/gatewayPort.ts`).
  The transcript tee is BLOCKED on a BE-1 seam decision first: BE-1's
  `QueryHandle.messages()` is single-consumer (the kernel pump) AND the SDK
  runner narrows the terminal result (usage/cost dropped from
  `RunnerResultMessage`), so a composition-root wrapping QueryRunner cannot
  feed `transcript-result` its usage fields. Either a BE-1 kernel tap on the
  RAW SDK stream or raw-result retention on the seam (an ICR — the testkit
  mirror syncs in the same change per the ICR-0001 drift rule) is required
  before the tee can be composed.
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
