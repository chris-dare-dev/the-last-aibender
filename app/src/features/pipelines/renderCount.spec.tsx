// @vitest-environment jsdom
/**
 * Streaming discipline for the pipelines deck (plan §9.2 FE-6 render-count row;
 * plan §5 FE iron rules): pipeline payloads land through the REAL GatewayClient
 * → bindPipelines rAF projector → ONE store write per frame. Deck commits are
 * bounded by frames — never by wire messages. Also pins the wire endings that
 * ride OUTSIDE the frame batch: a pushed §18.4 error applies immediately
 * (attention path) and a broker restart resets the projections.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  connectionStore,
  encodeEnvelope,
  GatewayClient,
  nullLogger,
  type ClientEvents,
} from '../../lib/index.ts';
import {
  FakeWsHub,
  ManualTimers,
  fakeBootstrap,
  flushAsync,
  manualFrames,
} from '../../lib/testing/fakes.ts';
import { bindPipelines } from './bind.ts';
import { pipelinesStore, stepKey, stepsForRun } from './store.ts';
import { PipelinesDeck } from './PipelinesDeck.tsx';
import { runStatusEvent, stepStatusEvent } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A step-status wire frame for run_1, distinct step per index. */
function stepFrame(seq: number, stepId: string, tokensOut: number): string {
  return encodeEnvelope('pipelines', seq, {
    ...stepStatusEvent('run_1', stepId, 'running', { account: 'MAX_A' }),
    tokensOut,
  });
}

describe('pipelines streaming discipline', () => {
  let root: Root | undefined;
  let host: HTMLElement;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    pipelinesStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    act(() => root?.unmount());
    root = undefined;
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
    dispose = bindPipelines(client, { schedule: frames.schedule });
    client.start();
    await flushAsync();
    hub.latest.open();
    await flushAsync();
    return { hub, frames };
  }

  it('per-message React updates are provably absent (render-count assertion)', async () => {
    const { hub, frames } = await setup();
    // Seed a run so the monitor resolves it (the deck defaults to the newest).
    hub.latest.receiveText(encodeEnvelope('pipelines', 0, runStatusEvent('run_1', 'running')));

    let commits = 0;
    function CountedDeck(): ReactNode {
      return (
        <Profiler id="pl-deck" onRender={() => (commits += 1)}>
          <PipelinesDeck />
        </Profiler>
      );
    }
    root = createRoot(host);
    act(() => (root as Root).render(<CountedDeck />));
    // Switch to the monitor so step rows are on screen.
    const toMonitor = host.querySelector<HTMLElement>('[data-testid="pl-mode-monitor"]');
    act(() => toMonitor?.click());
    const commitsAfterMount = commits;

    // Streaming fixture: 300 wire step upserts across three frame windows.
    const MESSAGES = 300;
    let storeNotifications = 0;
    const unsub = pipelinesStore.subscribe(() => (storeNotifications += 1));
    for (let i = 0; i < MESSAGES; i += 1) {
      hub.latest.receiveText(stepFrame(i + 1, `s${i % 24}`, i));
      if (i % 100 === 99) act(() => frames.frame());
    }
    unsub();

    // ONE store write per frame — three frames, three notifications.
    expect(storeNotifications).toBe(3);
    // Commits are bounded by frames, NEVER by the 300 wire messages.
    expect(commits - commitsAfterMount).toBeLessThanOrEqual(9);
    // …and the final projected values rendered (24 distinct steps upserted).
    expect(stepsForRun(pipelinesStore.getState(), 'run_1')).toHaveLength(24);
  });

  it('duplicate replayed seqs never produce duplicate projections (edge)', async () => {
    const { hub, frames } = await setup();
    hub.latest.receiveText(stepFrame(7, 'sdup', 10));
    hub.latest.receiveText(stepFrame(7, 'sdup', 99)); // duplicate seq — dropped upstream
    act(() => frames.frame());
    expect(stepsForRun(pipelinesStore.getState(), 'run_1')).toHaveLength(1);
    expect(pipelinesStore.getState().steps[stepKey('run_1', 'sdup', 0, 0)]?.tokensOut).toBe(10);
  });

  it('a pushed §18.4 error correlates by requestId IMMEDIATELY (attention path)', async () => {
    const { hub, frames } = await setup();
    pipelinesStore.getState().trackVerb({
      requestId: 'req_l',
      verb: 'pipeline-launch',
      phase: 'pending',
    });
    // The pushed error rides `control` (§7) with channel + correlatesTo.
    hub.latest.receiveText(
      encodeEnvelope('control', 0, {
        kind: 'error',
        code: 'pipeline-not-found',
        message: 'no such pipeline',
        retryable: false,
        correlatesTo: 'req_l',
        channel: 'pipelines',
      }),
    );
    // No frame pump: a verb failure is an attention path, not a stream.
    expect(pipelinesStore.getState().verbs['req_l']?.phase).toBe('failed');
    expect(pipelinesStore.getState().verbs['req_l']?.code).toBe('pipeline-not-found');
    // An error not correlated to a verb on the pipelines channel is ignored.
    hub.latest.receiveText(
      encodeEnvelope('control', 1, {
        kind: 'error',
        code: 'bad-request',
        message: 'unrelated',
        retryable: false,
        channel: 'events',
      }),
    );
    expect(Object.keys(pipelinesStore.getState().verbs)).toEqual(['req_l']);
    act(() => frames.frame());
  });

  it('a broker restart flushes the frame buffer, then resets every projection', () => {
    let listener: ClientEvents | undefined;
    const frames = manualFrames();
    const feed = {
      subscribe(l: ClientEvents) {
        listener = l;
        return () => (listener = undefined);
      },
    };
    dispose = bindPipelines(feed, { schedule: frames.schedule });
    listener?.onMessage?.({
      kind: 'pipelines',
      channel: 'pipelines',
      seq: 0,
      payload: runStatusEvent('run_1', 'running'),
    });
    // Still buffered (no frame yet) — the restart flushes THEN resets, so no
    // stale pre-restart snapshot can outlive the reset.
    listener?.onBrokerRestart?.();
    expect(pipelinesStore.getState().runs).toEqual({});
    expect(pipelinesStore.getState().runOrder).toEqual([]);
  });
});
