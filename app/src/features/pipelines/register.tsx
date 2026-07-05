/**
 * FE-6 pipelines registration — the ONE composition entry point (the FE-6
 * registerWorkstreams / FE-5 registerObservability precedent).
 *
 * The chrome mounts whatever occupies the `pipelines` island slot through the
 * islandRegistry seam and never imports this feature; the composition root
 * activates the builder + run monitor with a single call:
 *
 *   const dispose = registerPipelines(client);
 *
 * which (a) binds the `pipelines` channel to the pipelines store through the
 * rAF projector (bind.ts), (b) registers the deck island into the chrome
 * registry seam, and (c) registers the palette verb ("open pipelines" —
 * DESIGN.md §6 kill-switch rule). Everything reverses through the returned
 * dispose function (tests; the app never tears it down).
 *
 * TWO seams are ICRs to the chrome/lib owners (recorded in this return; the
 * registration DETECTS both structurally, so the moment they land composition
 * picks them up with no wiring change):
 *
 *   1. IslandSlot 'pipelines' — the `IslandSlot` union in
 *      chrome/islandRegistry.ts is chrome-owned and does not yet list
 *      'pipelines'. This module registers into that slot through a narrowly
 *      documented cast at the seam (PIPELINES_SLOT); the ICR widens the union
 *      and the cast becomes a no-op. Until then the deck simply is not mounted
 *      by the chrome (no error — the slot map ignores an unknown key on read).
 *   2. GatewayClient.sendPipelineMessage — the six frozen pipeline verbs ride
 *      the pipelines channel (ws-protocol.md §18.2). The GatewayClient method
 *      (the sendApprovalDecision / sendWorkstreamMergeRequest mirror) is an ICR
 *      to FE-2/lib; registration detects it structurally. Until it lands (or
 *      when the wire is down) the deck renders every verb dispatch as the
 *      `unsendable` instrument state — never a throw, never a toast.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerCommand } from '../../chrome/commands.ts';
import { registerIsland, type IslandMount, type IslandSlot } from '../../chrome/islandRegistry.ts';
import { bindPipelines, type PipelinesBindOptions } from './bind.ts';
import type { PipelineFeed, PipelineVerbSender } from './ports.ts';
import { PipelinesDeck, type PipelinesDeckProps } from './PipelinesDeck.tsx';

/**
 * The pipelines island slot. `IslandSlot` (chrome-owned) does not yet list
 * 'pipelines'; the cast is the ICR seam (task: ratify 'pipelines' IslandSlot).
 * A slot key the chrome does not know is simply never read back — safe until
 * the union + WorkSurface mount case land.
 */
export const PIPELINES_SLOT = 'pipelines' as IslandSlot;

export type RegisterPipelinesOptions = PipelinesBindOptions &
  Pick<PipelinesDeckProps, 'now' | 'sender' | 'newRequestId' | 'newNodeId'>;

/** The deck as an island mount (chrome/islandRegistry seam). */
export function pipelinesIsland(
  options: Pick<PipelinesDeckProps, 'now' | 'sender' | 'newRequestId' | 'newNodeId'> = {},
): IslandMount {
  return {
    mount(host) {
      const root = createRoot(host);
      root.render(
        <StrictMode>
          <PipelinesDeck
            {...(options.now !== undefined ? { now: options.now } : {})}
            {...(options.sender !== undefined ? { sender: options.sender } : {})}
            {...(options.newRequestId !== undefined ? { newRequestId: options.newRequestId } : {})}
            {...(options.newNodeId !== undefined ? { newNodeId: options.newNodeId } : {})}
          />
        </StrictMode>,
      );
      // Deferred: the host calls this from a React effect cleanup — a nested
      // root must never unmount synchronously while the outer root renders.
      return () => queueMicrotask(() => root.unmount());
    },
  };
}

/** Palette verb id (frequency-ranked with the chrome built-ins). */
export const FOCUS_PIPELINES_COMMAND_ID = 'pipelines.builder.focus';

/** Structural sender detection (the ICR-pending GatewayClient method). */
function senderOf(client: PipelineFeed): PipelineVerbSender | undefined {
  const candidate = client as PipelineFeed & Partial<PipelineVerbSender>;
  return typeof candidate.sendPipelineMessage === 'function'
    ? (candidate as PipelineFeed & PipelineVerbSender)
    : undefined;
}

/** Activate the pipelines builder + run monitor against a client. Returns dispose. */
export function registerPipelines(
  client: PipelineFeed,
  options: RegisterPipelinesOptions = {},
): () => void {
  const unbind = bindPipelines(
    client,
    options.schedule !== undefined ? { schedule: options.schedule } : {},
  );
  const sender = options.sender ?? senderOf(client);
  const unregisterIsland = registerIsland(
    PIPELINES_SLOT,
    pipelinesIsland({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(sender !== undefined ? { sender } : {}),
      ...(options.newRequestId !== undefined ? { newRequestId: options.newRequestId } : {}),
      ...(options.newNodeId !== undefined ? { newNodeId: options.newNodeId } : {}),
    }),
  );
  const unregisterCommand = registerCommand({
    id: FOCUS_PIPELINES_COMMAND_ID,
    title: 'open pipelines',
    keywords: 'pipeline builder catalog dag run monitor step account routing approval gate resume',
    run: () => {
      document.getElementById('ig-pipelines')?.scrollIntoView();
    },
  });
  return () => {
    unregisterCommand();
    unregisterIsland();
    unbind();
  };
}
