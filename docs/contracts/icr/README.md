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
