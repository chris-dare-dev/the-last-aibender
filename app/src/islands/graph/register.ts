/**
 * FE-4 registration — the ONE composition entry point for the graph island
 * (mirrors features/observability/register.tsx):
 *
 *   const dispose = registerGraphIsland(client);
 *
 * which (a) registers the island into the chrome `graph` slot (the
 * DESIGN.md-locked chrome integration — chrome mounts through the
 * islandRegistry seam and never imports this module), (b) binds the
 * `context-graph` channel to the island per mount (wsBind.ts), (c) registers
 * the palette verb (DESIGN.md §6 kill-switch rule), and (d) attaches the
 * day-one layer/cluster control strip inside the host.
 *
 * MOUNT LIFECYCLE:
 *  - on mount the island warm-starts from the FE-2 activity window
 *    (`contextGraphStore.recent`, bounded at 100 touches — honest depth: a
 *    late mount shows recent context, not all history), then goes LIVE on
 *    the wire feed;
 *  - on BROKER RESTART the projection is stale by definition; the island is
 *    torn down and rebuilt in place (fresh store + worker + renderer) — the
 *    lib stores reset on the same signal, so the warm-start window is
 *    consistent;
 *  - unmount disposes everything (worker terminated, Pixi destroyed).
 */

import type { ContextGraphTouch } from '@aibender/protocol';
import { registerCommand } from '../../chrome/commands.ts';
import { registerIsland, type IslandMount } from '../../chrome/islandRegistry.ts';
import { contextGraphStore } from '../../lib/stores/contextGraphStore.ts';
import { attachGraphControls } from './controls.ts';
import { mountGraphIsland, type GraphIslandHandle } from './graphIsland.ts';
import { bindGraphFeed, type ContextGraphFeed } from './wsBind.ts';

/** Palette verb id (frequency-ranked with the chrome built-ins). */
export const FOCUS_GRAPH_COMMAND_ID = 'graph.island.focus';

export interface RegisterGraphIslandOptions {
  /** Island factory (tests inject fakes; default = the real Pixi + worker). */
  createIsland?: (host: HTMLElement) => GraphIslandHandle;
  /** Warm-start touches (default: the FE-2 `contextGraphStore` window). */
  seedTouches?: () => readonly ContextGraphTouch[];
  /** Forwarded to the default factory. */
  seed?: number;
  reducedMotion?: boolean;
}

const defaultSeedTouches = (): readonly ContextGraphTouch[] =>
  contextGraphStore.getState().recent;

/** The graph island as a chrome mount (islandRegistry seam). */
export function graphIslandMount(
  client: ContextGraphFeed,
  options: RegisterGraphIslandOptions = {},
): IslandMount {
  const createIsland =
    options.createIsland ??
    ((host: HTMLElement): GraphIslandHandle =>
      mountGraphIsland({
        container: host,
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.reducedMotion !== undefined
          ? { reducedMotion: options.reducedMotion }
          : {}),
      }));
  const seedTouches = options.seedTouches ?? defaultSeedTouches;

  return {
    mount(host) {
      let disposed = false;
      let handle: GraphIslandHandle | undefined;
      let teardownScene: (() => void) | undefined;

      const build = (): void => {
        const island = createIsland(host);
        handle = island;
        const controls = attachGraphControls(host, island);
        const offBatch = island.store.onBatch(() => controls.refresh());
        teardownScene = () => {
          offBatch();
          controls.dispose();
          island.dispose();
          host.replaceChildren();
        };
        const seed = seedTouches();
        if (seed.length > 0) island.applyTouches(seed);
      };

      build();

      const unbind = bindGraphFeed(
        client,
        { applyTouches: (touches) => handle?.applyTouches(touches) },
        {
          onBrokerRestart: () => {
            if (disposed) return;
            // Boot identity changed: every node/edge/epoch is stale — rebuild
            // the whole scene rather than mutate a half-stale one.
            teardownScene?.();
            build();
          },
        },
      );

      return () => {
        if (disposed) return;
        disposed = true;
        unbind();
        teardownScene?.();
        handle = undefined;
      };
    },
  };
}

/** Activate the graph island feature against a client. Returns dispose. */
export function registerGraphIsland(
  client: ContextGraphFeed,
  options: RegisterGraphIslandOptions = {},
): () => void {
  const unregisterIsland = registerIsland('graph', graphIslandMount(client, options));
  const unregisterCommand = registerCommand({
    id: FOCUS_GRAPH_COMMAND_ID,
    title: 'focus context graph',
    keywords: 'graph context lineage files sessions touch layers cluster',
    run: () => {
      document.querySelector('[data-slot="graph"]')?.scrollIntoView();
    },
  });
  return () => {
    unregisterCommand();
    unregisterIsland();
  };
}
