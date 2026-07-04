/**
 * Gateway-port adapters (BE-2 → BE-3 seam; plan §1.3 no-file-conflict rule).
 *
 * The BE-3 gateway consumes PTY sessions through the `GatewayPtyHost` /
 * `GatewayPtySession` ports it declared in core/src/gateway/ports.ts. This
 * module adapts the BE-2 {@link PtyHost} onto STRUCTURALLY IDENTICAL local
 * types — kernel/ deliberately does not import gateway/ modules (layering:
 * the composition root in core/src/main/ owns cross-lane wiring; the
 * type-compatibility assertion lives in gatewayPort.spec.ts, where a
 * type-only cross-lane import is harmless).
 *
 * DIVISION OF FLOW-CONTROL LABOR (both sides SPIKE-D-derived, no double
 * buffering in the composed path):
 *   - the GATEWAY owns the wire-facing bounded ack buffer, the absolute
 *     `streamOffset` axis it serves to clients, reconnect replay, and the
 *     pause()/resume() lever pulls (gateway/ptyStream.ts);
 *   - the HOST owns the child + its standalone ring (detach/reattach and
 *     recycle-continuity for non-gateway consumers). When THIS adapter is the
 *     consumer, delivered bytes are acked into the host ring immediately —
 *     host-side occupancy stays ~0, the host ring never pauses the child, and
 *     the gateway's levers are the only backpressure driver. Both offset axes
 *     coincide: the adapter announces the session before its first byte and
 *     replays nothing, so gateway byte 0 = host ring offset 0.
 */

import type { ApprovalDecision, ApprovalRequest, ApprovalResolved } from '@aibender/protocol';

import type { ApprovalBroker } from '../approvals.js';
import { KernelError } from '../errors.js';
import type { AttendedPtySession, PtyHost } from './ptyHost.js';

// ---------------------------------------------------------------------------
// Structural mirrors of gateway/ports.ts (checked in gatewayPort.spec.ts)
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

/** Mirror of gateway/ports.ts `GatewayPtySession`. */
export interface GatewayPtySessionPort {
  onOutput(listener: (chunk: Uint8Array) => void): Unsubscribe;
  onExit(listener: () => void): Unsubscribe;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
}

/** Mirror of gateway/ports.ts `GatewayPtyHost`. */
export interface GatewayPtyHostPort {
  onSession(listener: (sessionId: string, session: GatewayPtySessionPort) => void): Unsubscribe;
}

/** Mirror of gateway/ports.ts `ApprovalDecisionOutcome` / `ApprovalBrokerPort`. */
export type ApprovalDecisionPortOutcome = 'applied' | 'not-pending';

export interface ApprovalBrokerGatewayPort {
  onRequest(listener: (request: ApprovalRequest) => void): Unsubscribe;
  onResolved(listener: (resolved: ApprovalResolved) => void): Unsubscribe;
  decide(decision: ApprovalDecision): Promise<ApprovalDecisionPortOutcome>;
}

// ---------------------------------------------------------------------------
// PtyHost → GatewayPtyHost
// ---------------------------------------------------------------------------

function toGatewaySession(session: AttendedPtySession): GatewayPtySessionPort {
  return {
    onOutput: (listener) => {
      // Single gateway consumer per session (the gateway fans out to its
      // connections itself). Auto-ack keeps the host ring drained — see the
      // module header's division-of-labor note.
      session.attach((frame) => {
        listener(frame.payload);
        session.ack(frame.streamOffset + frame.payload.byteLength);
      });
      return () => session.detach();
    },
    onExit: (listener) => {
      let live = true;
      void session.waitForExit().then(() => {
        if (live) listener();
      });
      return () => {
        live = false;
      };
    },
    write: (data) => session.write(data),
    resize: (cols, rows) => session.resize(cols, rows),
    pause: () => session.pause(),
    resume: () => session.resume(),
  };
}

/**
 * Adapt a BE-2 PtyHost onto the gateway's pty port. Announcement semantics
 * ride the host's `onSession` contract verbatim (live sessions replay
 * synchronously in spawn order; announcements precede first output).
 */
export function toGatewayPtyHostPort(host: PtyHost): GatewayPtyHostPort {
  return {
    onSession: (listener) =>
      host.onSession((session) => {
        listener(session.sessionId, toGatewaySession(session));
      }),
  };
}

// ---------------------------------------------------------------------------
// ApprovalBroker → ApprovalBrokerPort
// ---------------------------------------------------------------------------

/**
 * Adapt the BE-2 ApprovalBroker onto the gateway's approvals port. The
 * broker's typed `approval-not-pending` refusal becomes the port's
 * `'not-pending'` value (the NORMAL race — ws-protocol.md §7); the broker's
 * `bad-request` (updatedInput-on-deny defense) and anything else propagates —
 * the gateway validates wire shapes before calling decide, so a throw here
 * is a broker-side bug worth surfacing loudly.
 */
export function toApprovalBrokerGatewayPort(broker: ApprovalBroker): ApprovalBrokerGatewayPort {
  return {
    onRequest: (listener) =>
      broker.subscribe((message) => {
        if (message.kind === 'approval-request') listener(message);
      }),
    onResolved: (listener) =>
      broker.subscribe((message) => {
        if (message.kind === 'approval-resolved') listener(message);
      }),
    decide: async (decision) => {
      try {
        broker.decide(decision);
        return 'applied';
      } catch (cause) {
        if (cause instanceof KernelError && cause.code === 'approval-not-pending') {
          return 'not-pending';
        }
        throw cause;
      }
    },
  };
}
