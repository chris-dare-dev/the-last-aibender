/**
 * FE-6 workstream registration — the ONE composition entry point (the FE-5
 * registerObservability precedent).
 *
 * The chrome mounts whatever occupies the `workstreams` island slot through
 * the islandRegistry seam and never imports this feature; the composition
 * root activates the lineage view with a single call:
 *
 *   const dispose = registerWorkstreams(client);
 *
 * which (a) binds the `workstream` channel to the lineage store through the
 * rAF projector (bind.ts), (b) registers the deck island into the chrome
 * registry seam, and (c) registers the palette verb ("open workstreams" —
 * DESIGN.md §6 kill-switch rule). Everything reverses through the returned
 * dispose function (tests; the app never tears it down).
 *
 * Merge sender seam: the frozen `workstream-merge-request` verb rides the
 * workstream channel (ws-protocol.md §16.2). The GatewayClient method
 * (`sendWorkstreamMergeRequest`, the sendApprovalDecision mirror) is an ICR
 * to FE-2/lib — registration DETECTS it structurally, so the moment the lib
 * method lands, composition picks it up with no wiring change. Until then
 * (or when the wire is down) the deck renders merge dispatch as the
 * `unsendable` instrument state — never a throw, never a toast.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerCommand } from '../../chrome/commands.ts';
import { registerIsland, type IslandMount } from '../../chrome/islandRegistry.ts';
import { bindWorkstreams, type WorkstreamsBindOptions } from './bind.ts';
import type { WorkstreamFeed, WorkstreamMergeSender } from './ports.ts';
import { WorkstreamsDeck, type WorkstreamsDeckProps } from './WorkstreamsDeck.tsx';

export type RegisterWorkstreamsOptions = WorkstreamsBindOptions &
  Pick<WorkstreamsDeckProps, 'now' | 'sender' | 'newMergeId'>;

/** The deck as an island mount (chrome/islandRegistry seam). */
export function workstreamsIsland(
  options: Pick<WorkstreamsDeckProps, 'now' | 'sender' | 'newMergeId'> = {},
): IslandMount {
  return {
    mount(host) {
      const root = createRoot(host);
      root.render(
        <StrictMode>
          <WorkstreamsDeck
            {...(options.now !== undefined ? { now: options.now } : {})}
            {...(options.sender !== undefined ? { sender: options.sender } : {})}
            {...(options.newMergeId !== undefined ? { newMergeId: options.newMergeId } : {})}
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
export const FOCUS_WORKSTREAMS_COMMAND_ID = 'workstreams.lineage.focus';

/** Structural sender detection (the ICR-pending GatewayClient method). */
function senderOf(client: WorkstreamFeed): WorkstreamMergeSender | undefined {
  const candidate = client as WorkstreamFeed & Partial<WorkstreamMergeSender>;
  return typeof candidate.sendWorkstreamMergeRequest === 'function'
    ? (candidate as WorkstreamFeed & WorkstreamMergeSender)
    : undefined;
}

/** Activate the workstream lineage feature against a client. Returns dispose. */
export function registerWorkstreams(
  client: WorkstreamFeed,
  options: RegisterWorkstreamsOptions = {},
): () => void {
  const unbind = bindWorkstreams(
    client,
    options.schedule !== undefined ? { schedule: options.schedule } : {},
  );
  const sender = options.sender ?? senderOf(client);
  const unregisterIsland = registerIsland(
    'workstreams',
    workstreamsIsland({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(sender !== undefined ? { sender } : {}),
      ...(options.newMergeId !== undefined ? { newMergeId: options.newMergeId } : {}),
    }),
  );
  const unregisterCommand = registerCommand({
    id: FOCUS_WORKSTREAMS_COMMAND_ID,
    title: 'open workstreams',
    keywords: 'workstream lineage branch continue merge brief detached head advisory',
    run: () => {
      document.getElementById('ig-workstreams')?.scrollIntoView();
    },
  });
  return () => {
    unregisterCommand();
    unregisterIsland();
    unbind();
  };
}
