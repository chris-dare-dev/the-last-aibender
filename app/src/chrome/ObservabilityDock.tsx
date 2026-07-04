/**
 * Right-zone dock for the FE-5 observability deck (DESIGN.md §4.1: the
 * right zone is "the five channel panels in slot order, then aggregate
 * gauges" — this hosts the aggregate gauges). Pure wiring: the dock mounts
 * whatever occupies the `observability` island slot through the
 * islandRegistry seam and NEVER imports feature internals. While nothing is
 * registered it renders the NO SIGNAL treatment — a dimmed instrument, slot
 * retained, never an error.
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getIsland, islandsVersion, subscribeIslands } from './islandRegistry.ts';

export function ObservabilityDock(): ReactNode {
  useSyncExternalStore(subscribeIslands, islandsVersion, islandsVersion);
  const island = getIsland('observability');
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (island === undefined || host === null) return undefined;
    return island.mount(host, { sessionId: undefined });
  }, [island]);

  return (
    <section
      id="ig-observability"
      aria-label="observability dashboards"
      data-testid="observability-dock"
    >
      {island === undefined ? (
        <div className="ig-panel" data-status="nosignal" data-testid="observability-nosignal">
          <header className="ig-panel-header">
            <span className="ig-engraved">DASHBOARDS</span>
            <span className="ig-panel-readout ig-status-nosignal">NO SIGNAL</span>
          </header>
          <div className="ig-panel-detail">NO DASHBOARD ISLAND REGISTERED</div>
        </div>
      ) : (
        <div ref={hostRef} data-testid="observability-host" />
      )}
    </section>
  );
}
