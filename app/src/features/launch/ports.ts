/**
 * FE-5 launch feature — ports (plan §5/FE-5, M2 slice).
 *
 * The launch feature never touches the WebSocket, the DOM shell, or the
 * transcript island directly. It consumes three narrow ports that the FE-2
 * shell (app/src/lib — WS client + stores) and the FE-3 transcript island
 * provide at composition time:
 *
 *   - {@link LaunchControlPort} — dispatch one frozen ControlRequest on the
 *     `control` channel and resolve the correlated ControlResponse. The FE-2
 *     WS client owns envelope wrapping, per-connection seq assignment, and
 *     request/response correlation by id (ws-protocol.md §4). The reference
 *     wire shape this port must produce is pinned byte-for-byte against the
 *     golden corpus in wire.ts / wire.spec.ts.
 *   - {@link TranscriptOpener} — focus/open the transcript island on a
 *     harness session id (FE-3 surface; the launcher calls it with the
 *     sessionId returned by a successful launch).
 *   - {@link RequestIdSource} — client-generated control request ids
 *     (`REQUEST_ID_RE`); injectable so tests are deterministic.
 *
 * Until FE-2 lands its client, tests drive these ports with local fakes; the
 * concrete wiring is an FE-2 integration (see icr_requests in the FE-5
 * return).
 */

import type { ControlRequest, ControlResponse } from '@aibender/protocol';
import { REQUEST_ID_RE } from '@aibender/protocol';

/**
 * The slice of the FE-2 WS surface the launcher consumes. `dispatch` MUST:
 *   - send the request as the payload of a `control`-channel envelope;
 *   - resolve with the single ControlResponse whose id matches, already
 *     validated by `validateControlResponse` (client inbound discipline);
 *   - reject only on transport-level failure (socket down, timeout) — a
 *     broker `ok:false` result is a RESOLVED response, not a rejection.
 */
export interface LaunchControlPort {
  dispatch(request: ControlRequest): Promise<ControlResponse>;
}

/** FE-3 seam: open/focus the transcript island for a harness session id. */
export type TranscriptOpener = (sessionId: string) => void;

/** Injectable clock (epoch ms) so history rows are testable. */
export type Clock = () => number;

/** Client-generated control request ids (charset per REQUEST_ID_RE). */
export interface RequestIdSource {
  next(): string;
}

/**
 * Default id source: `req_<counter>_<entropy>` — unique within and across
 * connections without carrying any identity content. Deterministic tests
 * inject their own source instead.
 */
export function sequentialRequestIds(prefix = 'req'): RequestIdSource {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(prefix)) {
    throw new RangeError(`invalid request-id prefix ${JSON.stringify(prefix)}`);
  }
  let counter = 0;
  const entropy = Math.random().toString(36).slice(2, 8) || '0';
  return {
    next(): string {
      counter += 1;
      const id = `${prefix}_${String(counter)}_${entropy}`;
      // Programmer-error guard: the frozen wire regex is the contract.
      if (!REQUEST_ID_RE.test(id)) {
        throw new RangeError(`generated request id ${JSON.stringify(id)} violates REQUEST_ID_RE`);
      }
      return id;
    },
  };
}
