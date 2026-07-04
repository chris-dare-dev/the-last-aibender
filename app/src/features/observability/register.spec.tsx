// @vitest-environment jsdom
/**
 * Feature registration through the FE-2 chrome seams (plan §5/FE-5 wiring):
 * Positive: registerObservability binds the events channel, occupies the
 *           `observability` island slot and registers the palette verb; the
 *           chrome ObservabilityDock mounts the deck through the registry
 *           WITHOUT importing the feature.
 * Negative: an empty slot renders the dock's NO SIGNAL treatment — a dimmed
 *           instrument, never an error.
 * Edge:     dispose unwinds everything (slot, verb, binding).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { allCommands, resetCommandsForTest } from '../../chrome/commands.ts';
import { getIsland, resetIslandsForTest } from '../../chrome/islandRegistry.ts';
import { ObservabilityDock } from '../../chrome/ObservabilityDock.tsx';
import { connectionStore, quotaStore, type ClientEvents } from '../../lib/index.ts';
import { manualFrames } from '../../lib/testing/fakes.ts';
import { FOCUS_DASHBOARDS_COMMAND_ID, registerObservability } from './register.tsx';
import { observabilityStore } from './store.ts';
import { quotaGaugesSnap, src, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeFeed {
  listener: ClientEvents | undefined;
  subscribe(listener: ClientEvents): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

describe('registerObservability + ObservabilityDock', () => {
  let root: Root;
  let host: HTMLElement;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    observabilityStore.getState().reset();
    quotaStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    resetIslandsForTest();
    resetCommandsForTest();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    // async act: the island unmount is a queued microtask (register.tsx).
    await act(async () => dispose?.());
    dispose = undefined;
    act(() => root.unmount());
    host.remove();
    resetIslandsForTest();
    resetCommandsForTest();
    connectionStore.getState().reset();
  });

  it('an empty slot renders the dock NO SIGNAL treatment (negative)', () => {
    act(() => {
      root.render(<ObservabilityDock />);
    });
    const idle = host.querySelector('[data-testid="observability-nosignal"]');
    expect(idle).not.toBeNull();
    expect(idle?.getAttribute('data-status')).toBe('nosignal');
    expect(idle?.textContent).toContain('NO SIGNAL');
  });

  it('registration mounts the deck through the registry seam (positive)', () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerObservability(feed, { schedule: frames.schedule, now: () => T0 });
    });
    expect(getIsland('observability')).toBeDefined();
    expect(allCommands().some((c) => c.id === FOCUS_DASHBOARDS_COMMAND_ID)).toBe(true);

    act(() => {
      root.render(<ObservabilityDock />);
    });
    expect(host.querySelector('[data-testid="observability-deck"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-instrument]')).toHaveLength(10);

    // Wire → binding → store → deck, one frame later.
    feed.listener?.onMessage?.({
      kind: 'events',
      channel: 'events',
      seq: 0,
      payload: quotaGaugesSnap([src('fresh', 'claude-quota', T0 - 1000)]),
    } as never);
    act(() => frames.frame());
    expect(host.querySelector('[data-testid="quota-MAX_A-5h"]')?.textContent).toContain('41.5%');
  });

  it('dispose unwinds the slot, the verb and the binding (edge)', async () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerObservability(feed, { schedule: frames.schedule });
    });
    act(() => {
      root.render(<ObservabilityDock />);
    });
    expect(host.querySelector('[data-testid="observability-deck"]')).not.toBeNull();

    // async act: dispose queues the nested island unmount as a microtask.
    await act(async () => {
      dispose?.();
    });
    dispose = undefined;
    expect(getIsland('observability')).toBeUndefined();
    expect(allCommands().some((c) => c.id === FOCUS_DASHBOARDS_COMMAND_ID)).toBe(false);
    expect(feed.listener).toBeUndefined();
    // The dock falls back to the NO SIGNAL treatment.
    expect(host.querySelector('[data-testid="observability-nosignal"]')).not.toBeNull();
  });
});
