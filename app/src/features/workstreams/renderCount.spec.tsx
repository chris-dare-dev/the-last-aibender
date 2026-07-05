// @vitest-environment jsdom
/**
 * Streaming discipline for the lineage deck (plan §9.2 FE-6 render-count
 * row; plan §5 FE iron rules): workstream payloads land through the REAL
 * GatewayClient → bindWorkstreams rAF projector → ONE store write per frame.
 * Deck commits are bounded by frames — never by wire messages. Also pins the
 * wire endings that ride OUTSIDE the frame batch: pushed §16.4 errors apply
 * immediately (attention path) and a broker restart resets the projections.
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
import { bindWorkstreams } from './bind.ts';
import { workstreamsStore } from './store.ts';
import { WorkstreamsDeck } from './WorkstreamsDeck.tsx';
import { listSnap, nodeEvent, summary, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function nodeFrame(seq: number, sessionId: string, tokensOut: number): string {
  return encodeEnvelope('workstream', seq, {
    ...nodeEvent(sessionId, { workstreamId: 'ws_stream', createdAt: T0 + seq }),
    tokensOut,
  });
}

describe('lineage streaming discipline', () => {
  let root: Root | undefined;
  let host: HTMLElement;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    workstreamsStore.getState().reset();
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
    dispose = bindWorkstreams(client, { schedule: frames.schedule });
    client.start();
    await flushAsync();
    hub.latest.open();
    await flushAsync();
    return { hub, frames };
  }

  it('per-message React updates are provably absent (render-count assertion)', async () => {
    const { hub, frames } = await setup();

    // Seed the rail so the deck resolves the ws_stream scope.
    hub.latest.receiveText(encodeEnvelope('workstream', 0, listSnap([summary('ws_stream')], 0)));

    let commits = 0;
    function CountedDeck(): ReactNode {
      return (
        <Profiler
          id="lineage-deck"
          onRender={() => {
            commits += 1;
          }}
        >
          <WorkstreamsDeck />
        </Profiler>
      );
    }
    root = createRoot(host);
    act(() => {
      (root as Root).render(<CountedDeck />);
    });
    const commitsAfterMount = commits;

    // Streaming fixture: 300 wire node upserts across three frame windows.
    const MESSAGES = 300;
    let storeNotifications = 0;
    const unsub = workstreamsStore.subscribe(() => {
      storeNotifications += 1;
    });
    for (let i = 0; i < MESSAGES; i += 1) {
      hub.latest.receiveText(nodeFrame(i + 1, `ses_${i % 24}`, i));
      if (i % 100 === 99) {
        act(() => frames.frame()); // one projection per frame window
      }
    }
    unsub();

    // ONE store write per frame — three frames, three notifications.
    expect(storeNotifications).toBe(3);
    // Commits are bounded by frames, NEVER by the 300 wire messages.
    expect(commits - commitsAfterMount).toBeLessThanOrEqual(9);
    // …and the final projected values rendered (24 distinct nodes upserted).
    expect(host.querySelectorAll('[data-testid^="ws-node-"]')).toHaveLength(24);
    expect(Object.keys(workstreamsStore.getState().nodes)).toHaveLength(24);
  });

  it('duplicate replayed seqs never produce duplicate projections (edge)', async () => {
    const { hub, frames } = await setup();
    hub.latest.receiveText(nodeFrame(7, 'ses_dup', 10));
    hub.latest.receiveText(nodeFrame(7, 'ses_dup', 99)); // duplicate seq — dropped upstream
    act(() => frames.frame());
    expect(workstreamsStore.getState().nodes['ses_dup']?.tokensOut).toBe(10);
  });

  it('a pushed §16.4 error correlates by mergeId IMMEDIATELY (attention path)', async () => {
    const { hub, frames } = await setup();
    workstreamsStore
      .getState()
      .trackMerge({ mergeId: 'mrg_wire', phase: 'pending', parents: ['ses_a', 'ses_b'] });
    // The pushed error rides `control` (§7) with channel + correlatesTo.
    hub.latest.receiveText(
      encodeEnvelope('control', 0, {
        kind: 'error',
        code: 'session-not-found',
        message: 'a named parent has no session node',
        retryable: false,
        correlatesTo: 'mrg_wire',
        channel: 'workstream',
      }),
    );
    // No frame pump needed: merge failure is an attention path, not a stream.
    expect(workstreamsStore.getState().merges['mrg_wire']?.phase).toBe('failed');
    expect(workstreamsStore.getState().merges['mrg_wire']?.code).toBe('session-not-found');
    // Errors NOT correlated to a merge on the workstream channel are ignored.
    hub.latest.receiveText(
      encodeEnvelope('control', 1, {
        kind: 'error',
        code: 'bad-request',
        message: 'unrelated',
        retryable: false,
        channel: 'events',
      }),
    );
    expect(Object.keys(workstreamsStore.getState().merges)).toEqual(['mrg_wire']);
    act(() => frames.frame());
  });

  it('a broker restart flushes the frame buffer, then resets every projection', () => {
    // Bind-level seam: the client emits onBrokerRestart after discarding its
    // watermarks (boot identity changed) — every projection is stale.
    let listener: ClientEvents | undefined;
    const frames = manualFrames();
    const feed = {
      subscribe(l: ClientEvents) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    };
    dispose = bindWorkstreams(feed, { schedule: frames.schedule });
    listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 0,
      payload: listSnap([summary('ws_stream')], 2),
    });
    // Still buffered (no frame yet) — the restart flushes THEN resets, so no
    // stale pre-restart snapshot can outlive the reset.
    listener?.onBrokerRestart?.();
    expect(workstreamsStore.getState().rail).toBeUndefined();
    expect(workstreamsStore.getState().nodes).toEqual({});
  });

  it('FE-3: DEBUG-logs a dropped opaque (unknown-kind) payload with its kind', () => {
    const debugs: { msg: string; detail: Record<string, unknown> | undefined }[] = [];
    const logger = {
      ...nullLogger,
      debug: (msg: string, detail?: Record<string, unknown>) => debugs.push({ msg, detail }),
    };
    let listener: ClientEvents | undefined;
    const frames = manualFrames();
    const feed = {
      subscribe(l: ClientEvents) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    };
    dispose = bindWorkstreams(feed, { schedule: frames.schedule, logger });

    // An M5 broker sends a lens kind an M4 client does not know — legal by the
    // forward-tolerant reader rule, dropped, but now OBSERVABLE.
    listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 0,
      payload: { kind: 'lineage-advisory-v2', opaque: true },
    });
    act(() => frames.frame());

    // The store never saw it (forward-tolerant drop) …
    expect(workstreamsStore.getState().rail).toBeUndefined();
    expect(workstreamsStore.getState().nodes).toEqual({});
    // … and the drop is logged at DEBUG with the drift signal (the kind).
    const dropped = debugs.find((d) => d.msg.includes('opaque workstream'));
    expect(dropped).toBeDefined();
    expect(dropped?.detail).toEqual({ kind: 'lineage-advisory-v2' });
  });
});
