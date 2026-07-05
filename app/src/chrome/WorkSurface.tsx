/**
 * Center zone — the work surface. Hosts the imperative island registered
 * for the SELECTED session's slot (terminal/transcript — FE-3; graph —
 * FE-4) through the islandRegistry seam; renders the NO SIGNAL treatment
 * (a dimmed instrument — never an error toast, never an animated loader)
 * while no island/session is available.
 *
 * Slot policy (M2): the selected session's substrate picks the island —
 * `pty` (the attended TUI) mounts the terminal island; `sdk` (one-off
 * prompts) streams into the transcript island. Substrate-unknown sessions
 * (status hydration still in flight) default to transcript, and re-slot
 * when the status row lands.
 *
 * View policy (M4): the center zone is "active session (terminal/
 * transcript), graph, builder" (DESIGN.md §4.1) — the GRAPH toggle in the
 * panel header (and the "toggle graph view" palette verb, DESIGN.md §6
 * kill-switch rule) swaps the surface to the FE-4 context-graph island.
 * The graph is the whole session-artifact field, so it mounts regardless
 * of session selection; the toggle is an explicit user layout action
 * (geometry never reflows in response to data).
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Substrate } from '@aibender/protocol';
import { sessionsStore } from '../lib/stores/sessionsStore.ts';
import { getIsland, islandsVersion, subscribeIslands, type IslandSlot } from './islandRegistry.ts';
import { uiStore } from './uiStore.ts';

/** The M2 substrate → island slot mapping (exported for tests). */
export function slotForSubstrate(substrate: Substrate | undefined): IslandSlot {
  return substrate === 'pty' ? 'terminal' : 'transcript';
}

export function WorkSurface(): ReactNode {
  const selectedSessionId = useStore(uiStore, (s) => s.selectedSessionId);
  const view = useStore(uiStore, (s) => s.workSurfaceView);
  const toggleGraphView = useStore(uiStore, (s) => s.toggleGraphView);
  const substrate = useStore(sessionsStore, (s) =>
    selectedSessionId === undefined ? undefined : s.sessions[selectedSessionId]?.substrate,
  );
  useSyncExternalStore(subscribeIslands, islandsVersion, islandsVersion);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const graphView = view === 'graph';
  const slot: IslandSlot = graphView ? 'graph' : slotForSubstrate(substrate);
  // The graph view is session-independent (the whole session-artifact
  // field); session views need a selection before anything mounts. Keeping
  // the graph's mount context pinned to undefined means a selection change
  // never tears the scene down while the graph view is up.
  const island = graphView
    ? getIsland('graph')
    : selectedSessionId === undefined
      ? undefined
      : getIsland(slot);
  const mountSessionId = graphView ? undefined : selectedSessionId;

  useEffect(() => {
    const host = hostRef.current;
    if (island === undefined || host === null) return undefined;
    if (!graphView && mountSessionId === undefined) return undefined;
    return island.mount(host, { sessionId: mountSessionId });
  }, [island, mountSessionId, graphView]);

  return (
    <section className="ig-work" aria-label="work surface" data-testid="work-surface">
      <div className="ig-panel">
        <header className="ig-panel-header">
          <span className="ig-engraved">WORK</span>
          <span className="ig-panel-readout ig-engraved">
            {graphView
              ? 'CONTEXT GRAPH'
              : selectedSessionId === undefined
                ? 'NO SESSION SELECTED'
                : `SES ${selectedSessionId}`}
          </span>
          <button
            type="button"
            className="ig-btn"
            data-testid="work-view-toggle"
            aria-pressed={graphView}
            onClick={toggleGraphView}
          >
            GRAPH
          </button>
        </header>
      </div>
      <div className="ig-well">
        {island === undefined ? (
          <div className="ig-well-idle">
            <div className="ig-engraved" style={{ color: 'var(--ig-ink-faint)' }}>
              NO SIGNAL
            </div>
            <div className="ig-engraved" style={{ color: 'var(--ig-ink-faint)' }}>
              {!graphView && selectedSessionId === undefined
                ? 'NO SESSION SELECTED'
                : 'NO ISLAND REGISTERED'}
            </div>
          </div>
        ) : (
          <div
            ref={hostRef}
            className="ig-island-host"
            data-testid="island-host"
            data-slot={slot}
          />
        )}
      </div>
    </section>
  );
}
