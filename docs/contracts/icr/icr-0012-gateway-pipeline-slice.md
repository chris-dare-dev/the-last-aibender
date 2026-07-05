# ICR-0012 — gateway pipeline-channel seam (the M5 wire, compose-ready)

- Requesting lane: BE-8 (the catalog scanner & pipeline engine lane; landed
  with the M5 build — the ICR-0011 precedent: the seam a frozen surface
  requires lands WITH the lane that builds against it, recorded here for
  BE-ORCH ratification + FE-ORCH co-sign)
- Surface: `core/src/gateway/ports.ts` (one new port type + its error/param
  shapes), `core/src/gateway/server.ts` (pipelines-verb delegation +
  `publishPipeline`), `core/src/gateway/serverPipelines.spec.ts` (new),
  `core/src/gateway/index.ts` (port-type exports)
- Freeze state at request time: gateway M4-frozen behavior; the M5 freeze
  already registered the `pipelines` channel (ws-protocol.md §18) and landed
  the gateway's `handlePipelinesPayload` STUB (validate answered directly,
  every other verb degraded to `pipeline-not-found`) — this ICR replaces the
  stub's degrade with real engine delegation.

## Motivation

The M5 freeze registered the `pipelines` channel with six CLIENT verbs
(`pipeline-validate|save|launch|pause|resume|cancel`, §18.2), a broker→client
payload union (§18.1), and the §18.4 error contract, and extended the golden
corpus with those frames. The freeze agent landed a STUB handler so the wire
contract stayed green, deferring the engine port to BE-8 (the exact ICR-0009 /
ICR-0011 situation: the freeze lands the minimal seam; the building lane lands
the port). BE-8's `createPipelineEngine` (core/src/pipelines/) is that engine;
it needs a gateway seam to reach the wire — mirroring the M4
`WorkstreamEnginePort`.

## Change (minimal, port-shaped, absent-by-default)

1. **`PipelineEnginePort`** (gateway ports.ts): `validate` / `save` / `launch`
   / `pause` / `resume` / `cancel`. Typed rejections via a structural
   `PipelineVerbErrorLike` (the frozen §18.4 codes: `bad-request`,
   `pipeline-not-found`, `pipeline-run-not-found`, `pipeline-invalid`,
   `step-not-found`, `internal`) — the ICR-0002 structural-guard posture (the
   gateway never imports BE-8's error class; a `PipelineVerbError`-shaped throw
   is recognized by its `code`). BE-8's `createPipelineEngine` implements it;
   composeBroker wires it.
2. **Gateway routing**: client payloads on `pipelines` validate against the
   FROZEN `validatePipelineClientMessage`, then delegate to the port.
   `pipeline-validate` is answered DIRECTLY (pure static validation, engine or
   not). For `pipeline-invalid` the engine's validation issue rides a
   `pipeline-validation-result` payload AND a GENERIC pushed error (§18.4:
   detail on the payload, the error stays generic [X2]). ABSENT port → the
   runtime degrade `pipeline-not-found` (the empty-broker posture, unchanged
   from the freeze stub).
3. **`publishPipeline(payload)`** on the gateway handle: validated, journaled
   (replayable §8) broadcast — refuses invalid AND unregistered-kind payloads
   (forward tolerance is a READER rule). BE-8's run/step-status + catalog
   fan-out source; the mirror of `publishWorkstream`.

## Compatibility

- Additive: one optional gateway option (`pipelines`), one handle method
  (`publishPipeline`), the port + its shapes exported from the gateway barrel;
  NO existing composition changes when `pipelines` is absent (the default
  everywhere until an operator composes the executor). All prior golden
  fixtures replay byte-identically — the freeze's `pipeline-validate` /
  degrade behavior is preserved for the absent-engine path.
- Verified: `core/src/gateway/serverPipelines.spec.ts` (10: validate direct,
  bad-request on the verb, verb delegation, saved answer, §18.4 mappings
  incl. the pipeline-invalid validation-result + generic error, generic
  internal on a non-typed throw, absent-engine degrade, publishPipeline
  fan-out + replay-from-0, producer-discipline refusals),
  `core/src/main/composedPipelines.spec.ts` (the DoD demo: MAX_A → AWS_DEV →
  LOCAL with a mid-run gate paused + resumed from the inbox, over one composed
  broker), and the full `serverGolden.spec.ts` corpus replays green.
- Reversal path: delete the port/option/handle-method/branch + the two new
  specs, restore the freeze stub's `pipeline-not-found` degrade for every
  non-validate verb; nothing outside composeBroker and these specs depends on
  them.

## Sign-off

- Owning orchestrator (BE-ORCH): **RATIFIED 2026-07-05** (landed by the BE-8
  build lane per the ICR-0009/0011 freeze-seam precedent; reviewed by BE-ORCH
  M5-ICR stewarding — additive, absent-engine degrade preserved, both new
  specs + the full `serverGolden.spec.ts` corpus replay green).
- Counterpart orchestrator (FE-ORCH): **pending** — the FE inbound router
  already flows `pipelines` frames generically to `onMessage` (the M5
  forward-tolerant reader path); the FE-6 pipeline-builder slice consumes them
  through the BE-ORCH-landed client `sendPipelineMessage` seam + the chrome
  `'pipelines'` slot (recorded in the icr/README post-M5 stewarding section).
  No FE change is bundled in THIS ICR. Flip at the M5 gate review.
