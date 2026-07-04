// @vitest-environment jsdom
/**
 * Streaming discipline for the dashboards (plan §9.2 FE-5: render-count
 * assertion; plan §5 FE iron rules): read-model snapshots land through the
 * REAL GatewayClient → bindObservability rAF projector → ONE store write per
 * frame. Deck commits are bounded by frames — never by wire messages.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { encodeEnvelope, GatewayClient, connectionStore, quotaStore, nullLogger } from '../../lib/index.ts';
import {
  FakeWsHub,
  ManualTimers,
  fakeBootstrap,
  flushAsync,
  manualFrames,
} from '../../lib/testing/fakes.ts';
import { bindObservability } from './bind.ts';
import { ObservabilityDeck } from './ObservabilityDeck.tsx';
import { observabilityStore } from './store.ts';
import { T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function offloadFrame(seq: number, ratioPct: number): string {
  return encodeEnvelope('events', seq, {
    kind: 'read-model-snapshot',
    readModel: 'local-offload',
    capturedAt: T0 + seq,
    sources: [{ source: 'lmstudio', state: 'fresh', lastIngestAt: T0 }],
    data: { offloadRatioPct: ratioPct, localTokens: 200, totalTokens: 900, windowDays: 7 },
  });
}

describe('dashboard streaming discipline', () => {
  let root: Root | undefined;
  let host: HTMLElement;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    observabilityStore.getState().reset();
    quotaStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    dispose?.();
    act(() => root?.unmount());
    host.remove();
    connectionStore.getState().reset();
  });

  async function setup(): Promise<{ hub: FakeWsHub; frames: ReturnType<typeof manualFrames> }> {
    const hub = new FakeWsHub();
    const timers = new ManualTimers();
    const frames = manualFrames();
    const client = new GatewayClient({
      bootstrapProvider: async () => fakeBootstrap(),
      wsFactory: hub.factory,
      timers,
      logger: nullLogger,
    });
    dispose = bindObservability(client, { schedule: frames.schedule });
    client.start();
    await flushAsync();
    hub.latest.open();
    await flushAsync();
    return { hub, frames };
  }

  it('per-message React updates are provably absent (render-count assertion)', async () => {
    const { hub, frames } = await setup();

    let commits = 0;
    function CountedDeck(): ReactNode {
      return (
        <Profiler
          id="deck"
          onRender={() => {
            commits += 1;
          }}
        >
          <ObservabilityDeck now={() => T0} />
        </Profiler>
      );
    }
    root = createRoot(host);
    act(() => {
      (root as Root).render(<CountedDeck />);
    });
    const commitsAfterMount = commits;

    // Streaming fixture: 300 wire snapshots across three frame windows.
    const MESSAGES = 300;
    let storeNotifications = 0;
    const unsub = observabilityStore.subscribe(() => {
      storeNotifications += 1;
    });
    for (let i = 0; i < MESSAGES; i += 1) {
      hub.latest.receiveText(offloadFrame(i, (i % 1000) / 10));
      if (i % 100 === 99) {
        act(() => frames.frame()); // one projection per frame window
      }
    }
    unsub();

    // ONE store write per frame — three frames, three notifications.
    expect(storeNotifications).toBe(3);
    // Commits are bounded by frames (a small constant covers the phosphor
    // freshness effect), NEVER by the 300 wire messages.
    expect(commits - commitsAfterMount).toBeLessThanOrEqual(9);
    // …and the final projected value rendered.
    expect(host.querySelector('[data-testid="offload-ratio"]')?.textContent).toContain('29.9%');
  });

  it('duplicate replayed seqs never produce duplicate projections (edge)', async () => {
    const { hub, frames } = await setup();
    hub.latest.receiveText(offloadFrame(7, 10));
    hub.latest.receiveText(offloadFrame(7, 99)); // duplicate seq — dropped upstream
    act(() => frames.frame());
    const slot = observabilityStore.getState().snapshots['local-offload'];
    expect(slot?.data.offloadRatioPct).toBe(10);
  });
});
