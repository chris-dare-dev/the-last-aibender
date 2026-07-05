// @vitest-environment jsdom
/**
 * Feature registration through the FE-2 chrome seams (plan §5/FE-6 wiring):
 * Positive: registerWorkstreams binds the workstream channel, occupies the
 *           `workstreams` island slot and registers the palette verb; the
 *           registry mounts the deck WITHOUT chrome importing the feature.
 * Negative: without a merge sender on the client, the deck is handed NO
 *           sender (unsendable posture) — nothing throws.
 * Edge:     dispose unwinds everything (slot, verb, binding); a client that
 *           exposes the ICR-pending `sendWorkstreamMergeRequest` method is
 *           detected structurally and wired straight through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { WorkstreamMergeRequest } from '@aibender/protocol';
import { allCommands, resetCommandsForTest } from '../../chrome/commands.ts';
import { getIsland, resetIslandsForTest } from '../../chrome/islandRegistry.ts';
import { connectionStore, type ClientEvents } from '../../lib/index.ts';
import { manualFrames } from '../../lib/testing/fakes.ts';
import { FOCUS_WORKSTREAMS_COMMAND_ID, registerWorkstreams } from './register.tsx';
import { workstreamsStore } from './store.ts';
import { listSnap, nodeEvent, summary } from './specHelpers.ts';

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

class FakeSendingClient extends FakeFeed {
  requests: WorkstreamMergeRequest[] = [];
  sendWorkstreamMergeRequest(request: WorkstreamMergeRequest): boolean {
    this.requests.push(request);
    return true;
  }
}

describe('registerWorkstreams + the registry seam', () => {
  let host: HTMLElement;
  let unmountIsland: (() => void) | undefined;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    workstreamsStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    resetIslandsForTest();
    resetCommandsForTest();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
    // async act: the island unmount is a queued microtask (register.tsx).
    await act(async () => unmountIsland?.());
    unmountIsland = undefined;
    await act(async () => dispose?.());
    dispose = undefined;
    host.remove();
    resetIslandsForTest();
    resetCommandsForTest();
    connectionStore.getState().reset();
  });

  it('an empty slot stays empty until registration (negative)', () => {
    expect(getIsland('workstreams')).toBeUndefined();
    expect(allCommands().some((c) => c.id === FOCUS_WORKSTREAMS_COMMAND_ID)).toBe(false);
  });

  it('registration occupies the slot, the verb, and mounts the deck (positive)', () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerWorkstreams(feed, { schedule: frames.schedule });
    });
    const island = getIsland('workstreams');
    expect(island).toBeDefined();
    expect(allCommands().some((c) => c.id === FOCUS_WORKSTREAMS_COMMAND_ID)).toBe(true);

    act(() => {
      unmountIsland = island?.mount(host, { sessionId: undefined });
    });
    expect(host.querySelector('[data-testid="workstreams-deck"]')).not.toBeNull();

    // Wire → binding → store → deck, one frame later.
    feed.listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 0,
      payload: listSnap([summary('ws_reg')], 3),
    });
    act(() => frames.frame());
    expect(host.querySelector('[data-testid="ws-rail-readout"]')?.textContent).toBe(
      '1 WS · 3 DET',
    );
    expect(host.querySelector('[data-testid="ws-rail-ws_reg"]')).not.toBeNull();
  });

  it('opaque payloads are ignored by the binding (frozen reader rule)', () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerWorkstreams(feed, { schedule: frames.schedule });
    });
    feed.listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 0,
      payload: { kind: 'm5-pipeline-lens', opaque: true },
    });
    act(() => frames.frame());
    expect(workstreamsStore.getState().rail).toBeUndefined();
    expect(workstreamsStore.getState().nodes).toEqual({});
  });

  it('detects the ICR-pending sender method structurally (edge)', () => {
    const client = new FakeSendingClient();
    const frames = manualFrames();
    act(() => {
      dispose = registerWorkstreams(client, { schedule: frames.schedule });
    });
    const island = getIsland('workstreams');
    act(() => {
      unmountIsland = island?.mount(host, { sessionId: undefined });
    });
    feedNodes(client, frames);
    // Select both nodes and dispatch through the mounted deck: the request
    // reaches the CLIENT method — proof the structural detection wired it.
    click('ws-node-ses_a');
    click('ws-node-ses_b');
    click('ws-merge-seed');
    const purpose = host.querySelector<HTMLInputElement>('[data-testid="ws-merge-purpose"]');
    if (purpose === null) throw new Error('missing purpose input');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(purpose, 'wired through');
      purpose.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('ws-merge-dispatch');
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.params.parents).toEqual(['ses_a', 'ses_b']);
  });

  it('dispose unwinds the slot, the verb and the binding (edge)', async () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerWorkstreams(feed, { schedule: frames.schedule });
    });
    expect(getIsland('workstreams')).toBeDefined();
    await act(async () => {
      dispose?.();
    });
    dispose = undefined;
    expect(getIsland('workstreams')).toBeUndefined();
    expect(allCommands().some((c) => c.id === FOCUS_WORKSTREAMS_COMMAND_ID)).toBe(false);
    expect(feed.listener).toBeUndefined();
  });

  function feedNodes(feed: FakeFeed, frames: ReturnType<typeof manualFrames>): void {
    feed.listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 0,
      payload: listSnap([summary('ws_reg')], 0),
    });
    feed.listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 1,
      payload: nodeEvent('ses_a', { workstreamId: 'ws_reg', cwd: '/synthetic/workspace' }),
    });
    feed.listener?.onMessage?.({
      kind: 'workstream',
      channel: 'workstream',
      seq: 2,
      payload: nodeEvent('ses_b', { workstreamId: 'ws_reg', cwd: '/synthetic/workspace' }),
    });
    act(() => frames.frame());
  }

  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing element ${testId}`);
    act(() => el.click());
  }
});
