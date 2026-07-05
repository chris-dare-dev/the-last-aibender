/**
 * Gateway-facing M2 ports (plan §4/BE-3, blueprint §2) — the seams through
 * which the BE-3 gateway consumes the rest of the broker WITHOUT importing
 * other lanes' packages (the same discipline as ./kernel.ts `GatewayKernel`).
 *
 * The composition root (core/src/main/, owner BE-ORCH) adapts the real
 * producers onto these ports at startup:
 *
 *   - {@link GatewayPtyHost}      ← BE-2's ptyHost (core/src/kernel/pty/,
 *                                    parallel M2 lane). The gateway holds the
 *                                    CONSUMER side of the SPIKE-D ack-watermark
 *                                    discipline (./ptyStream.ts); the host owns
 *                                    the node-pty child and its ring buffer.
 *   - {@link ApprovalBrokerPort}  ← BE-2's ApprovalBroker (canUseTool +
 *                                    hook-floor waits; workflow gates at M5).
 *   - {@link TranscriptSource}    ← a tap on the kernel's per-session SDK
 *                                    message stream (BE-1 QueryHandle.messages
 *                                    — the composition root tees the RAW SDK
 *                                    messages to this port; the gateway
 *                                    projects them into the frozen
 *                                    transcript.<sid> payloads,
 *                                    ./transcriptProjector.ts).
 *
 * Every port is OPTIONAL on GatewayOptions: an absent port degrades the
 * corresponding channel to its empty-stub behavior (documented per option in
 * ./server.ts) so the gateway keeps composing while parallel lanes land.
 *
 * Test doubles live in @aibender/testkit (FakePtyHost, FakePtySession,
 * FakeApprovalBroker, FakeTranscriptSource — promoted from ./fakePorts.ts
 * via ICR-0007; testkit keeps a structural mirror of these port types, same
 * drift rule as the ICR-0001 queryRunner mirror).
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolved,
  DagDocument,
  WorkstreamMergeRequest,
  WorkstreamMergeResolved,
} from '@aibender/protocol';

/** Return value of every `on*` subscription: call to unsubscribe. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// PTY host port (BE-2 adapter target)
// ---------------------------------------------------------------------------

/**
 * One live attended PTY session as the gateway consumes it. Byte-oriented and
 * deliberately parser-free (plan §9.2 BE-2 negative row: semantic parsing of
 * PTY bytes is absent by construction — nothing here exposes structure).
 *
 * PAUSE/RESUME NEVER CROSS THE WIRE (ws-protocol.md §6): they are the
 * broker-internal backpressure levers the gateway's bounded ack buffer pulls
 * when occupancy crosses its watermarks. The host maps them onto
 * `pty.pause()`/`resume()` so the child's TTY writes block (SPIKE-D vi).
 */
export interface GatewayPtySession {
  /**
   * Subscribe to OUTPUT bytes. The host emits every byte exactly once, in
   * order, starting from the session's byte 0 — the gateway assigns absolute
   * `streamOffset`s by counting (the frozen watermark axis, §5/§6).
   */
  onOutput(listener: (chunk: Uint8Array) => void): Unsubscribe;
  /** Subscribe to session end (child exited or was reaped). */
  onExit(listener: () => void): Unsubscribe;
  /** Client INPUT bytes (keystrokes/paste) for the attended session. */
  write(data: Uint8Array): void;
  /** Terminal geometry change (bounds validated wire-side, §6). */
  resize(cols: number, rows: number): void;
  /** Backpressure: stop producing (ack-buffer occupancy ≥ highWater). */
  pause(): void;
  /** Backpressure released (occupancy drained to ≤ lowWater). */
  resume(): void;
}

/**
 * The BE-2 ptyHost as the gateway sees it: an announcement stream of live
 * PTY sessions. `onSession` MUST replay already-live sessions to a new
 * subscriber (synchronously, in spawn order) and then announce future spawns
 * — the gateway subscribes once at boot and counts each session's output
 * stream from the announcement onward (offset 0 = first byte after
 * announcement; the host announces before emitting any output).
 */
export interface GatewayPtyHost {
  onSession(listener: (sessionId: string, session: GatewayPtySession) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Approval broker port (BE-2 adapter target)
// ---------------------------------------------------------------------------

/**
 * Outcome of delivering one client decision to the approval broker.
 *  - `applied`      the approval was pending; the broker took the verdict and
 *                   will emit exactly one matching `onResolved` event.
 *  - `not-pending`  unknown id, already resolved, or expired — the NORMAL
 *                   multi-window/expiry race (ws-protocol.md §7): the gateway
 *                   answers the decider `approval-not-pending`, nothing else
 *                   changes. This is what makes double-decisions idempotent:
 *                   the first decision wins, every later one is `not-pending`.
 */
export type ApprovalDecisionOutcome = 'applied' | 'not-pending';

/**
 * BE-2's ApprovalBroker as the gateway sees it: the single approval inbox
 * feed for every escalation source (blueprint §4.1 two-layer permission
 * relay). Payload shapes are the FROZEN wire types — the broker builds them
 * (identifier-free summaries, placeholder labels [X2]); the gateway validates
 * defensively and fans out.
 */
export interface ApprovalBrokerPort {
  /** A decision is wanted. Fired once per approvalId. */
  onRequest(listener: (request: ApprovalRequest) => void): Unsubscribe;
  /**
   * Terminal fan-out (allowed · denied · expired · superseded). Fired exactly
   * once per approvalId, after the wait settled broker-side.
   */
  onResolved(listener: (resolved: ApprovalResolved) => void): Unsubscribe;
  /** Deliver a validated client decision. See {@link ApprovalDecisionOutcome}. */
  decide(decision: ApprovalDecision): Promise<ApprovalDecisionOutcome>;
}

// ---------------------------------------------------------------------------
// Transcript source port (kernel message-stream tap)
// ---------------------------------------------------------------------------

/**
 * A tap on the kernel's per-session SDK message stream. `message` is the RAW
 * SDK message object (the value BE-1's QueryHandle stream yields before the
 * kernel narrows it to init/result/other — RunnerOtherMessage.raw wrappers
 * are also accepted and unwrapped). The gateway owns the projection into the
 * frozen `transcript.<sid>` payload union (./transcriptProjector.ts) — the
 * tap stays dumb so the composition root can tee bytes without knowing wire
 * shapes.
 */
export interface TranscriptSource {
  onMessage(listener: (sessionId: string, message: unknown) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Workstream engine port (BE-7 adapter target — M4 freeze, ICR-0011)
// ---------------------------------------------------------------------------

/**
 * BE-7's workstream/lineage engine as the gateway sees it: the handler for
 * the ONE client verb on the `workstream` channel (ws-protocol.md §16).
 *
 * Contract:
 *  - `merge` receives an ALREADY-VALIDATED request (the gateway ran the
 *    frozen validator) and resolves with the `workstream-merge-resolved`
 *    fan-out payload once the merge node + its N `merge_parent` edges are
 *    recorded (the engine publishes the node/edge upserts itself through the
 *    broker's `publishWorkstream`).
 *  - Typed rejections use {@link KernelVerbError} (./kernel.js) with the
 *    frozen merge error codes: `session-not-found` (unknown parent),
 *    `workstream-not-found` (unknown workstreamId), `bad-request` (engine-
 *    side shape refusals), anything else maps to `internal` with a GENERIC
 *    message. The gateway answers PUSHED errors with
 *    `correlatesTo: mergeId` + `channel: 'workstream'`.
 *  - ABSENT PORT (the every-port-is-optional rule above): the gateway still
 *    VALIDATES merge requests, then answers the runtime error
 *    `session-not-found` — a broker with no lineage engine composed has no
 *    session nodes, so every parent is unknown (truthful degrade; mirrors
 *    the approvals `approval-not-pending` empty-broker posture).
 */
export interface WorkstreamEnginePort {
  merge(request: WorkstreamMergeRequest): Promise<WorkstreamMergeResolved>;
}

// ---------------------------------------------------------------------------
// Pipeline engine port (BE-8 adapter target — M5 freeze, ICR-0012)
// ---------------------------------------------------------------------------

/**
 * BE-8's pipeline engine as the gateway sees it: the handler for the frozen
 * `pipelines` client verbs (ws-protocol.md §18.2). The gateway validates the
 * verb SHAPE (`validatePipelineClientMessage`), then delegates here.
 *
 * Contract (mirrors the ICR-0011 `WorkstreamEnginePort` posture):
 *  - `validate` is PURE static DAG validation — the gateway answers this ITSELF
 *    when no engine is composed (no engine needed); the port supports it too.
 *  - Typed rejections use {@link PipelineVerbError} with the frozen §18.4
 *    codes (`bad-request`, `pipeline-not-found`, `pipeline-run-not-found`,
 *    `pipeline-invalid`, `step-not-found`, `internal`). For `pipeline-invalid`
 *    the error carries the validation issue class so the gateway ALSO pushes a
 *    `pipeline-validation-result` (§18.4: detail rides the validation payload,
 *    the error stays GENERIC [X2]).
 *  - The engine PUBLISHES run/step-status + catalog snapshots itself through
 *    the broker's {@link GatewayHandle.publishPipeline}; the verb handlers here
 *    only start/steer runs and answer `pipeline-saved` / errors.
 *  - ABSENT PORT (the every-port-optional rule): the gateway still VALIDATES
 *    verbs; `pipeline-validate` answers a validation-result directly; every
 *    other verb answers the runtime degrade `pipeline-not-found` (an empty
 *    broker has no saved pipelines or runs).
 */
export interface PipelineVerbErrorLike {
  readonly code:
    | 'bad-request'
    | 'pipeline-not-found'
    | 'pipeline-run-not-found'
    | 'pipeline-invalid'
    | 'step-not-found'
    | 'internal';
  readonly message: string;
  /** Present for `pipeline-invalid`: the §4 issue class the gateway relays. */
  readonly validation?: {
    readonly issueCode: string;
    readonly issueMessage: string;
    readonly issuePath: string;
  };
}

export interface PipelineValidateResult {
  readonly valid: boolean;
  readonly issueCode?: string;
  readonly issueMessage?: string;
  readonly issuePath?: string;
}

export interface PipelineLaunchParams {
  readonly pipelineId?: string;
  readonly document?: DagDocument;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly workstreamId?: string;
}

export interface PipelineEnginePort {
  validate(document: unknown): PipelineValidateResult;
  /** Persist a definition; returns its id (answered `pipeline-saved`). May throw PipelineVerbErrorLike. */
  save(document: DagDocument): { readonly pipelineId: string };
  /** Start a run (fire-and-forget; the walk publishes its own status). May throw. */
  launch(params: PipelineLaunchParams): { readonly runId: string };
  pause(runId: string): void;
  resume(runId: string): { readonly runId: string };
  cancel(runId: string): void;
}
