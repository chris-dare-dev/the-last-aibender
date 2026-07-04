/**
 * ============================================================================
 * DRAFT — NOT FROZEN. Departments MUST NOT build against this file as stable.
 * ============================================================================
 *
 * What remains draft after the M2 full freeze (2026-07-04):
 *
 *   - `events` channel payload union — DEFERRED TO M3, explicitly recorded in
 *     the M2 freeze (ws-protocol.md §8 / amendment record). The union is the
 *     collector fan-out shape and cannot be designed honestly before BE-5's
 *     normalized events store lands (plan §4/BE-5, M3); freezing a guess at
 *     M2 would guarantee an ICR at M3. The CHANNEL itself (name, stream,
 *     broker→client direction, seq/replay semantics per replay.ts) IS frozen —
 *     only the payload union is open.
 *
 * Promoted OUT of this file at the M2 freeze (now frozen surfaces):
 *   quota.ts · approvals.ts · transcript.ts · contextGraph.ts · replay.ts,
 *   and the WS auth transport (connect-time token; ws-protocol.md §1 — the
 *   separate "handshake message" placeholder was resolved as NOT NEEDED).
 *
 * Changing this file before M3 needs no ICR; promoting any of it into the
 * frozen surface does.
 */

/** Common shape every draft payload will refine. */
export interface DraftPayloadBase {
  /** Discriminant; concrete kinds land with the M3 events freeze. */
  readonly kind: string;
}

/** `events` channel payloads (collector fan-out, BE-5/BE-6) — freezes M3. */
export interface EventsPayloadDraft extends DraftPayloadBase {}
