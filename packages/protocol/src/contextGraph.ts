/**
 * `context-graph` channel payload — the live graph feed (feature 6,
 * blueprint §8 "Feed" bullet): the hook/JSONL/SSE watcher publishes file
 * touches; the FE graph island turns them into node/edge mutations.
 *
 * Broker → client only; the only client→broker payload the channel accepts
 * is the generic `replay-request` (replay.ts).
 *
 * [X2] DESIGN PIN — identity-free by construction: payloads carry file paths
 * and harness session ids ONLY. There is no account field, and the validator
 * actively REJECTS payloads carrying `account`/`accountLabel` keys (defense
 * against a careless broker-side producer, not just schema minimalism). The
 * blueprint is explicit: "graph payloads are file paths and session ids — no
 * account identifiers needed at all".
 *
 * Relations map from the hook vocabulary (docs/contracts/hooks-contract.md):
 *   read          PostToolUse on read-shaped tools (Read/Glob/Grep/…)
 *   write         PostToolUse on write-shaped tools (Write/Edit/…)
 *   instructions  InstructionsLoaded (CLAUDE.md / rules)
 *   watched       FileChanged (watched artifacts)
 *
 * ============================================================================
 * FROZEN-M2 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

export const CONTEXT_GRAPH_RELATIONS = Object.freeze([
  'read',
  'write',
  'instructions',
  'watched',
] as const);

export type ContextGraphRelation = (typeof CONTEXT_GRAPH_RELATIONS)[number];

export interface ContextGraphTouch {
  readonly kind: 'context-touch';
  /** Harness session id (never a native id). */
  readonly sessionId: string;
  /** Absolute file path of the touched artifact. */
  readonly path: string;
  readonly relation: ContextGraphRelation;
  /** Epoch ms of the touch as observed by the collector. */
  readonly ts: number;
}
