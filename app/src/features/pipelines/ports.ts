/**
 * FE-6 pipelines feature ports — the narrow structural seams this feature
 * needs from the FE-2 client stack (the FE-6 workstreams ports.ts precedent,
 * itself the observability EventsFeed precedent: features depend on SHAPES,
 * tests inject fakes, the composition root passes the real GatewayClient).
 *
 * The verb SENDER port is deliberately separate from the feed: the six frozen
 * pipeline verbs (`pipeline-validate` / `-save` / `-launch` / `-pause` /
 * `-resume` / `-cancel`) ride the `pipelines` channel (ws-protocol.md §18.2 —
 * the §16.2 merge-request precedent: a feature-scoped verb rides its own
 * fan-out channel, not `control`). The M5 GatewayClient does not yet expose a
 * `sendPipelineMessage` mirror of `sendWorkstreamMergeRequest`; that
 * one-method seam is an ICR to FE-2/lib (recorded in this return). Until it
 * lands the deck renders every verb dispatch as the `unsendable` instrument
 * state — never a throw, never a toast (NO SIGNAL doctrine, DESIGN.md §2.4).
 */

import type { PipelineClientPayload } from '@aibender/protocol';
import type { ClientEvents } from '../../lib/index.ts';

/** The structural slice of GatewayClient the pipelines binding subscribes to. */
export interface PipelineFeed {
  subscribe(listener: ClientEvents): () => void;
}

/**
 * Outbound seam for the frozen pipeline verbs (ws-protocol.md §18.2). Mirrors
 * `GatewayClient.sendApprovalDecision` / `sendWorkstreamMergeRequest`: returns
 * false when not connected (the caller renders the unsendable state; nothing
 * throws). ONE method carries all six verbs — the union is discriminated on
 * `kind`, exactly as the workstream merge verb rides one method.
 */
export interface PipelineVerbSender {
  sendPipelineMessage(message: PipelineClientPayload): boolean;
}

/** Injectable clock (tests pin it; default Date.now). */
export type Clock = () => number;

/** Injectable request-id mint (tests pin it; the control-request-id shape). */
export type RequestIdSource = () => string;
