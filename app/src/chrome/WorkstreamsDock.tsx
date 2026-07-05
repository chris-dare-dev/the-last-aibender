/**
 * Left-zone dock for the FE-6 workstream lineage deck (DESIGN.md §4.1: the
 * left zone is "fleet: workstream tree, session list, pipeline runs" — this
 * hosts the workstream tree, below the session list). Pure wiring — the
 * ObservabilityDock pattern verbatim: the dock mounts whatever occupies the
 * `workstreams` island slot through the islandRegistry seam and NEVER
 * imports feature internals. While nothing is registered it renders the NO
 * SIGNAL treatment — a dimmed instrument, slot retained, never an error.
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getIsland, islandsVersion, subscribeIslands } from './islandRegistry.ts';

export function WorkstreamsDock(): ReactNode {
  useSyncExternalStore(subscribeIslands, islandsVersion, islandsVersion);
  const island = getIsland('workstreams');
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (island === undefined || host === null) return undefined;
    return island.mount(host, { sessionId: undefined });
  }, [island]);

  return (
    <section aria-label="workstream lineage" data-testid="workstreams-dock">
      {island === undefined ? (
        <div className="ig-panel" data-status="nosignal" data-testid="workstreams-nosignal">
          <header className="ig-panel-header">
            <span className="ig-engraved">WORKSTREAMS</span>
            <span className="ig-panel-readout ig-status-nosignal">NO SIGNAL</span>
          </header>
          <div className="ig-panel-detail">NO LINEAGE ISLAND REGISTERED</div>
        </div>
      ) : (
        <div ref={hostRef} data-testid="workstreams-host" />
      )}
    </section>
  );
}
