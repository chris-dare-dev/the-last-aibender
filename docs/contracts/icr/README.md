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
