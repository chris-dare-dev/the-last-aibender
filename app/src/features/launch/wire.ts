/**
 * FE-5 wire helpers — reference frames for the launch dispatch path.
 *
 * The FE-2 WS client owns the socket; these builders exist so that
 *   1. the launcher hands FE-2 a request that is PROVABLY valid — every
 *      outbound request is screened through the frozen
 *      `validateControlRequest` before it leaves this feature;
 *   2. the exact wire bytes the dispatch path implies are pinned against the
 *      EXISTING golden corpus (packages/testkit `GOLDEN_WS_FIXTURES` —
 *      `control-launch-*` fixtures) byte-for-byte in wire.spec.ts;
 *   3. inbound launch responses are interpreted with the same discipline the
 *      corpus pins for broker→client control frames (`result-launch-ok`,
 *      `result-unknown-state`, `result-unregistered-error-code`).
 *
 * JSON.stringify key order is insertion order, so builders construct objects
 * in the frozen frame order: envelope {stream, channel, seq, payload};
 * payload {kind, id, params}.
 */

import {
  REQUEST_ID_RE,
  validateControlRequest,
  validateControlResponse,
  type ControlResponse,
  type Envelope,
  type ErrorDetail,
  type LaunchParams,
  type LaunchRequest,
  type SessionState,
} from '@aibender/protocol';

/**
 * Build a launch request and screen it through the FROZEN validator.
 * Throws on programmer error (bad id / params that the frozen wire rules
 * reject) — wire data never throws, but OUTBOUND construction bugs must not
 * reach the socket (golden corpus discipline).
 */
export function buildLaunchRequest(id: string, params: LaunchParams): LaunchRequest {
  if (!REQUEST_ID_RE.test(id)) {
    throw new RangeError(`request id ${JSON.stringify(id)} violates REQUEST_ID_RE`);
  }
  const request: LaunchRequest = { kind: 'launch', id, params };
  const verdict = validateControlRequest(request);
  if (!verdict.ok) {
    throw new RangeError(`refusing to dispatch an invalid launch: ${verdict.message}`);
  }
  return request;
}

/**
 * Wrap a control payload in the frozen envelope shape. `seq` is the
 * per-connection counter the FE-2 client owns; exposed here for the golden
 * byte-equality pins and as the reference implementation.
 */
export function controlEnvelope<TPayload>(seq: number, payload: TPayload): Envelope<TPayload> {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`seq must be a non-negative safe integer, got ${String(seq)}`);
  }
  return { stream: 'control', channel: 'control', seq, payload };
}

/** Serialize an envelope to the exact text-frame bytes (one frame, no gaps). */
export function serializeControlFrame(envelope: Envelope<unknown>): string {
  return JSON.stringify(envelope);
}

// ---------------------------------------------------------------------------
// Inbound: launch-response interpretation (client-side discipline)
// ---------------------------------------------------------------------------

export type LaunchOutcome =
  | { readonly kind: 'accepted'; readonly sessionId: string; readonly state: SessionState }
  | { readonly kind: 'wire-error'; readonly error: ErrorDetail }
  | {
      /**
       * The frame failed the frozen client-side validators, answered a
       * different request id, or answered a different verb. Never rendered
       * as broker truth; the dispatch records a failure.
       */
      readonly kind: 'invalid';
      readonly reason: string;
    };

/**
 * Interpret a broker control response for a launch dispatched with
 * `expectedId`. Runs the FROZEN `validateControlResponse` even though the
 * port promises validated frames — golden fixtures `result-unknown-state`
 * and `result-unregistered-error-code` MUST land in `invalid` regardless of
 * what an FE-2 implementation forgot.
 */
export function interpretLaunchResponse(payload: unknown, expectedId: string): LaunchOutcome {
  const verdict = validateControlResponse(payload);
  if (!verdict.ok) return { kind: 'invalid', reason: verdict.message };

  const response: ControlResponse = verdict.value;
  if (response.id !== expectedId) {
    return { kind: 'invalid', reason: 'response id does not match the dispatched request' };
  }
  if (!response.ok) return { kind: 'wire-error', error: response.error };
  if (response.result.verb !== 'launch') {
    return { kind: 'invalid', reason: `expected a launch result, got ${response.result.verb}` };
  }
  // Any registered SessionState is legal here (ws-protocol §4.1 M1
  // composition note: spawning | running | exited are all valid answers).
  return { kind: 'accepted', sessionId: response.result.sessionId, state: response.result.state };
}
