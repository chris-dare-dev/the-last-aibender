// @vitest-environment jsdom
/**
 * Feature registration through the FE-2 chrome seams (plan §5/FE-6 wiring):
 * Positive: registerPipelines binds the pipelines channel, occupies the
 *           `pipelines` island slot and registers the palette verb; the
 *           registry mounts the deck WITHOUT chrome importing the feature.
 * Negative: without a verb sender on the client, the deck is handed NO sender
 *           (unsendable posture) — nothing throws.
 * Edge:     dispose unwinds everything (slot, verb, binding); a client that
 *           exposes the ICR-pending `sendPipelineMessage` method is detected
 *           structurally and wired straight through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { PipelineClientPayload } from '@aibender/protocol';
import { allCommands, resetCommandsForTest } from '../../chrome/commands.ts';
import { getIsland, resetIslandsForTest } from '../../chrome/islandRegistry.ts';
import { connectionStore, type ClientEvents } from '../../lib/index.ts';
import { manualFrames } from '../../lib/testing/fakes.ts';
import { FOCUS_PIPELINES_COMMAND_ID, PIPELINES_SLOT, registerPipelines } from './register.tsx';
import { pipelinesStore } from './store.ts';
import { catalogEntry, catalogSnapshot, runStatusEvent } from './specHelpers.ts';

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
  messages: PipelineClientPayload[] = [];
  sendPipelineMessage(message: PipelineClientPayload): boolean {
    this.messages.push(message);
    return true;
  }
}

describe('registerPipelines + the registry seam', () => {
  let host: HTMLElement;
  let unmountIsland: (() => void) | undefined;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    pipelinesStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    resetIslandsForTest();
    resetCommandsForTest();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
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
    expect(getIsland(PIPELINES_SLOT)).toBeUndefined();
    expect(allCommands().some((c) => c.id === FOCUS_PIPELINES_COMMAND_ID)).toBe(false);
  });

  it('registration occupies the slot, the verb, and mounts the deck (positive)', () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerPipelines(feed, { schedule: frames.schedule });
    });
    const island = getIsland(PIPELINES_SLOT);
    expect(island).toBeDefined();
    expect(allCommands().some((c) => c.id === FOCUS_PIPELINES_COMMAND_ID)).toBe(true);

    act(() => {
      unmountIsland = island?.mount(host, { sessionId: undefined });
    });
    expect(host.querySelector('[data-testid="pipelines-deck"]')).not.toBeNull();

    // Wire → binding → store → deck, one frame later.
    feed.listener?.onMessage?.({
      kind: 'pipelines',
      channel: 'pipelines',
      seq: 0,
      payload: catalogSnapshot([catalogEntry('cap_reg', { name: 'write-report' })]),
    });
    act(() => frames.frame());
    expect(host.querySelector('[data-testid="pl-cap-cap_reg"]')).not.toBeNull();
  });

  it('opaque payloads are ignored by the binding (frozen reader rule)', () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerPipelines(feed, { schedule: frames.schedule });
    });
    feed.listener?.onMessage?.({
      kind: 'pipelines',
      channel: 'pipelines',
      seq: 0,
      payload: { kind: 'pipeline-cost-rollup-m6', opaque: true },
    });
    act(() => frames.frame());
    expect(pipelinesStore.getState().catalog).toEqual({});
    expect(pipelinesStore.getState().runs).toEqual({});
  });

  it('detects the ICR-pending sender method structurally (edge)', () => {
    const client = new FakeSendingClient();
    const frames = manualFrames();
    act(() => {
      dispose = registerPipelines(client, { schedule: frames.schedule });
    });
    const island = getIsland(PIPELINES_SLOT);
    act(() => {
      unmountIsland = island?.mount(host, { sessionId: undefined });
    });
    // Seed a resumable run and resume through the mounted deck: the message
    // reaches the CLIENT method — proof the structural detection wired it.
    client.listener?.onMessage?.({
      kind: 'pipelines',
      channel: 'pipelines',
      seq: 0,
      payload: runStatusEvent('run_reg', 'paused', { resumable: true }),
    });
    act(() => frames.frame());
    click('pl-mode-monitor');
    click('pl-run-run_reg');
    click('pl-run-resume');
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]?.kind).toBe('pipeline-resume');
  });

  it('dispose unwinds the slot, the verb and the binding (edge)', async () => {
    const feed = new FakeFeed();
    const frames = manualFrames();
    act(() => {
      dispose = registerPipelines(feed, { schedule: frames.schedule });
    });
    expect(getIsland(PIPELINES_SLOT)).toBeDefined();
    await act(async () => {
      dispose?.();
    });
    dispose = undefined;
    expect(getIsland(PIPELINES_SLOT)).toBeUndefined();
    expect(allCommands().some((c) => c.id === FOCUS_PIPELINES_COMMAND_ID)).toBe(false);
    expect(feed.listener).toBeUndefined();
  });

  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing element ${testId}`);
    act(() => el.click());
  }
});
