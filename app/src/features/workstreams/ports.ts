/**
 * FE-6 workstream feature ports — the narrow structural seams this feature
 * needs from the FE-2 client stack (the observability EventsFeed precedent:
 * features depend on SHAPES, tests inject fakes, the composition root passes
 * the real GatewayClient).
 *
 * The merge SENDER port is deliberately separate from the feed: the frozen
 * `workstream-merge-request` verb rides the workstream channel (ws-protocol.md
 * §16.2 — the approvals-decision precedent), but the M4 GatewayClient does not
 * yet expose a `sendWorkstreamMergeRequest` mirror of `sendApprovalDecision`.
 * That one-method seam is an ICR to FE-2/lib (recorded in the FE-6 M4 return);
 * until it lands the deck renders the merge dispatch as an unsendable
 * instrument state — never a throw, never a toast.
 */

import type { WorkstreamMergeRequest } from '@aibender/protocol';
import type { ClientEvents } from '../../lib/index.ts';

/** The structural slice of GatewayClient the workstream binding needs. */
export interface WorkstreamFeed {
  subscribe(listener: ClientEvents): () => void;
}

/**
 * Outbound seam for THE one lineage verb the FE sends (ws-protocol.md §16.2).
 * Mirrors `GatewayClient.sendApprovalDecision`: returns false when not
 * connected (the caller renders the unsendable state; nothing throws).
 */
export interface WorkstreamMergeSender {
  sendWorkstreamMergeRequest(request: WorkstreamMergeRequest): boolean;
}

/** Injectable clock (tests pin it; default Date.now). */
export type Clock = () => number;
