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
  const substrate = useStore(sessionsStore, (s) =>
    selectedSessionId === undefined ? undefined : s.sessions[selectedSessionId]?.substrate,
  );
  useSyncExternalStore(subscribeIslands, islandsVersion, islandsVersion);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const slot = slotForSubstrate(substrate);
  const island = selectedSessionId === undefined ? undefined : getIsland(slot);

  useEffect(() => {
    const host = hostRef.current;
    if (island === undefined || host === null || selectedSessionId === undefined) return undefined;
    return island.mount(host, { sessionId: selectedSessionId });
  }, [island, selectedSessionId]);

  return (
    <section className="ig-work" aria-label="work surface" data-testid="work-surface">
      <div className="ig-panel">
        <header className="ig-panel-header">
          <span className="ig-engraved">WORK</span>
          <span className="ig-panel-readout ig-engraved">
            {selectedSessionId === undefined ? 'NO SESSION SELECTED' : `SES ${selectedSessionId}`}
          </span>
        </header>
      </div>
      <div className="ig-well">
        {island === undefined ? (
          <div className="ig-well-idle">
            <div className="ig-engraved" style={{ color: 'var(--ig-ink-faint)' }}>
              NO SIGNAL
            </div>
            <div className="ig-engraved" style={{ color: 'var(--ig-ink-faint)' }}>
              {selectedSessionId === undefined ? 'NO SESSION SELECTED' : 'NO ISLAND REGISTERED'}
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
