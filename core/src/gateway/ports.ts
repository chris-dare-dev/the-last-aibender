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

import type { ApprovalDecision, ApprovalRequest, ApprovalResolved } from '@aibender/protocol';

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
