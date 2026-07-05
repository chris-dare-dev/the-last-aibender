// @vitest-environment jsdom
/**
 * Streaming discipline for the supervision instrument (plan §9.2 FE M6:
 * render-count assertion; plan §5 FE iron rules). resource-health snapshots
 * land through the REAL GatewayClient → bindObservability rAF projector → ONE
 * store write per frame. Instrument commits are bounded by frames — never by
 * wire messages. This is the same seam the ten §6.3 leads ride: the sibling
 * adds no new intake, so the discipline is proven end-to-end on this kind.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { encodeEnvelope, GatewayClient, connectionStore, nullLogger } from '../../lib/index.ts';
import {
  FakeWsHub,
  ManualTimers,
  fakeBootstrap,
  flushAsync,
  manualFrames,
} from '../../lib/testing/fakes.ts';
import { bindObservability } from './bind.ts';
import { ResourceHealthInstrument } from './ResourceHealthInstrument.tsx';
import { observabilityStore } from './store.ts';
import { T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A resource-health frame whose pressure varies with seq (movement to render). */
function rhFrame(seq: number, freeRamPct: number): string {
  return encodeEnvelope('events', seq, {
    kind: 'read-model-snapshot',
    readModel: 'resource-health',
    capturedAt: T0 + seq,
    sources: [{ source: 'lmstudio', state: 'fresh', lastIngestAt: T0 }],
    data: {
      pressureLevel: 1,
      pressureState: 'normal',
      freeRamPct,
      swapUsedBytes: 0,
      residentSessionCount: 1,
      sessions: [{ account: 'MAX_A', backend: 'claude_code', slot: 0, footprintMb: 2000, band: 'ok' }],
      notices: [],
    },
  });
}

describe('supervision instrument streaming discipline', () => {
  let root: Root | undefined;
  let host: HTMLElement;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    observabilityStore.getState().reset();
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
    function Counted(): ReactNode {
      return (
        <Profiler
          id="rh"
          onRender={() => {
            commits += 1;
          }}
        >
          <ResourceHealthInstrument now={() => T0} />
        </Profiler>
      );
    }
    root = createRoot(host);
    act(() => {
      (root as Root).render(<Counted />);
    });
    const commitsAfterMount = commits;

    // Streaming fixture: 300 wire snapshots across three frame windows.
    const MESSAGES = 300;
    let storeNotifications = 0;
    const unsub = observabilityStore.subscribe(() => {
      storeNotifications += 1;
    });
    for (let i = 0; i < MESSAGES; i += 1) {
      hub.latest.receiveText(rhFrame(i, (i % 1000) / 10));
      if (i % 100 === 99) {
        act(() => frames.frame());
      }
    }
    unsub();

    // ONE store write per frame — three frames, three notifications.
    expect(storeNotifications).toBe(3);
    // Commits bounded by frames (a small constant covers the tick effect),
    // NEVER by the 300 wire messages.
    expect(commits - commitsAfterMount).toBeLessThanOrEqual(9);
    // …and the final projected pressure rendered.
    expect(host.querySelector('[data-testid="pressure-detail"]')?.textContent).toContain('FREE 29.9%');
  });

  it('duplicate replayed seqs never produce duplicate projections (edge)', async () => {
    const { hub, frames } = await setup();
    root = createRoot(host);
    act(() => {
      (root as Root).render(<ResourceHealthInstrument now={() => T0} />);
    });
    hub.latest.receiveText(rhFrame(7, 40));
    hub.latest.receiveText(rhFrame(7, 99)); // duplicate seq — dropped upstream
    act(() => frames.frame());
    const slot = observabilityStore.getState().snapshots['resource-health'];
    expect(slot?.data.freeRamPct).toBe(40);
  });
});
