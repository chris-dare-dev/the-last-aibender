/**
 * FE-5 observability registration — the ONE composition entry point.
 *
 * The chrome mounts whatever occupies the `observability` island slot
 * (chrome/ObservabilityDock.tsx) and never imports this feature; the
 * composition root activates the feature with a single call:
 *
 *   const dispose = registerObservability(client);
 *
 * which (a) binds the events channel to the observability store through the
 * rAF projector (bind.ts), (b) registers the deck island into the chrome
 * registry seam, and (c) registers the palette verb ("focus dashboards" —
 * DESIGN.md §6 kill-switch rule). Everything reverses through the returned
 * dispose function (tests; the app never tears it down).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerCommand } from '../../chrome/commands.ts';
import { registerIsland, type IslandMount } from '../../chrome/islandRegistry.ts';
import { bindObservability, type EventsFeed, type ObservabilityBindOptions } from './bind.ts';
import { ObservabilityDeck, type ObservabilityDeckProps } from './ObservabilityDeck.tsx';
import { ResourceHealthInstrument } from './ResourceHealthInstrument.tsx';

export type RegisterObservabilityOptions = ObservabilityBindOptions &
  Pick<ObservabilityDeckProps, 'now' | 'copyText'>;

/**
 * The observability instruments as an island mount (chrome/islandRegistry
 * seam): the ten §6.3 dashboard leads (ObservabilityDeck), then the M6
 * supervision/governor instrument (ResourceHealthInstrument) as a SIBLING —
 * separate producer, separate read model, same engraved shell + store seam.
 * Both consume the one rAF-projected observability store; nothing here
 * reaches into the deck's internals.
 */
export function observabilityIsland(
  options: Pick<ObservabilityDeckProps, 'now' | 'copyText'> = {},
): IslandMount {
  const now = options.now !== undefined ? { now: options.now } : {};
  const copyText = options.copyText !== undefined ? { copyText: options.copyText } : {};
  return {
    mount(host) {
      const root = createRoot(host);
      root.render(
        <StrictMode>
          <ObservabilityDeck {...now} {...copyText} />
          <ResourceHealthInstrument {...now} {...copyText} />
        </StrictMode>,
      );
      // Deferred: the dock calls this from a React effect cleanup — a nested
      // root must never unmount synchronously while the outer root renders.
      return () => queueMicrotask(() => root.unmount());
    },
  };
}

/** Palette verb id (frequency-ranked with the chrome built-ins). */
export const FOCUS_DASHBOARDS_COMMAND_ID = 'observability.dashboards.focus';

/** Activate the observability feature against a client. Returns dispose. */
export function registerObservability(
  client: EventsFeed,
  options: RegisterObservabilityOptions = {},
): () => void {
  const unbind = bindObservability(
    client,
    options.schedule !== undefined ? { schedule: options.schedule } : {},
  );
  const unregisterIsland = registerIsland(
    'observability',
    observabilityIsland({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.copyText !== undefined ? { copyText: options.copyText } : {}),
    }),
  );
  const unregisterCommand = registerCommand({
    id: FOCUS_DASHBOARDS_COMMAND_ID,
    title: 'focus dashboards',
    keywords:
      'observability instruments quota burn cost cache latency skills offload resource pressure supervision memory footprint shed recycle',
    run: () => {
      document.getElementById('ig-observability')?.scrollIntoView();
    },
  });
  return () => {
    unregisterCommand();
    unregisterIsland();
    unbind();
  };
}
