/**
 * ============================================================================
 * DRAFT — NOT FROZEN. Everything in this file freezes at M2 (plan §3:
 * "M1 core, M2 full"). Placeholder shapes only: departments MUST NOT build
 * against these as stable. Changing this file before M2 needs no ICR;
 * promoting any of it into the frozen surface does.
 * ============================================================================
 *
 * Reserved payload families for the channels whose message unions land at M2:
 *   - events        (collector fan-out, BE-5/BE-6)
 *   - quota         (statusline rate_limits snapshots, BE-5)
 *   - approvals     (permission relay + workflow gates; pairs with the
 *                    reserved `approve` control verb)
 *   - transcript.<sid> (SDK message stream projection, BE-3/FE-3)
 *   - context-graph (graph feed envelopes, BE-6/FE-4)
 * Also reserved for M2: the WS auth handshake message (per-boot token,
 *   bootstrap-file contract) — until then auth is specified in prose only
 *   (docs/contracts/ws-protocol.md §DRAFT).
 */

/** Common shape every draft payload will refine. */
export interface DraftPayloadBase {
  /** Discriminant; concrete kinds land with the M2 freeze. */
  readonly kind: string;
}

export interface EventsPayloadDraft extends DraftPayloadBase {}
export interface QuotaPayloadDraft extends DraftPayloadBase {}
export interface ApprovalsPayloadDraft extends DraftPayloadBase {}
export interface TranscriptPayloadDraft extends DraftPayloadBase {}
export interface ContextGraphPayloadDraft extends DraftPayloadBase {}
