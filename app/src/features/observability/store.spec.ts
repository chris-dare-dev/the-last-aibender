/**
 * Observability store + events binding (plan §9.2 FE-5):
 * Positive: latest snapshot per read model; one notification per batch;
 *           read-model snapshots project through the binding.
 * Negative: event-summary and opaque (unknown-kind) payloads never reach the
 *           store (the frozen forward-tolerant reader rule); malformed
 *           events frames are dropped upstream and project nothing.
 * Edge:     an older replayed capture never regresses an instrument;
 *           broker restart resets every projection; dispose stops intake.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientEvents } from '../../lib/index.ts';
import { manualFrames } from '../../lib/testing/fakes.ts';
import { bindObservability } from './bind.ts';
import { latestSnapshot, observabilityStore } from './store.ts';
import { fullDeckSnapshots, quotaGaugesSnap, src, T0 } from './specHelpers.ts';

class FakeFeed {
  listener: ClientEvents | undefined;
  subscribe(listener: ClientEvents): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emitEvents(payload: unknown): void {
    this.listener?.onMessage?.({
      kind: 'events',
      channel: 'events',
      seq: 0,
      payload,
    } as never);
  }
  emitRestart(): void {
    this.listener?.onBrokerRestart?.();
  }
}

describe('observabilityStore', () => {
  beforeEach(() => observabilityStore.getState().reset());

  it('keeps the latest snapshot per read model and notifies once per batch', () => {
    let notifications = 0;
    const unsub = observabilityStore.subscribe(() => {
      notifications += 1;
    });
    observabilityStore.getState().applyBatch(fullDeckSnapshots());
    unsub();
    expect(notifications).toBe(1);
    const slots = observabilityStore.getState().snapshots;
    expect(Object.keys(slots)).toHaveLength(10);
    expect(latestSnapshot(slots, 'quota-gauges')?.data.gauges[0]?.usedPct).toBe(41.5);
    expect(latestSnapshot(slots, 'local-offload')?.data.offloadRatioPct).toBe(22.2);
  });

  it('an older replayed capture never regresses an instrument (edge)', () => {
    const fresh = quotaGaugesSnap([src('fresh')], [
      { account: 'MAX_A', window: '5h', usedPct: 50, resetsAt: T0 + 1 },
    ]);
    const stale = quotaGaugesSnap(
      [src('fresh')],
      [{ account: 'MAX_A', window: '5h', usedPct: 10, resetsAt: T0 + 1 }],
      T0 - 5_000,
    );
    observabilityStore.getState().applyBatch([fresh]);
    observabilityStore.getState().applyBatch([stale]);
    expect(
      latestSnapshot(observabilityStore.getState().snapshots, 'quota-gauges')?.data.gauges[0]
        ?.usedPct,
    ).toBe(50);
  });

  it('an empty batch does not notify subscribers', () => {
    let notifications = 0;
    const unsub = observabilityStore.subscribe(() => {
      notifications += 1;
    });
    observabilityStore.getState().applyBatch([]);
    unsub();
    expect(notifications).toBe(0);
  });
});

describe('bindObservability', () => {
  let feed: FakeFeed;
  let frames: ReturnType<typeof manualFrames>;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    observabilityStore.getState().reset();
    feed = new FakeFeed();
    frames = manualFrames();
    dispose = bindObservability(feed, { schedule: frames.schedule });
  });

  afterEach(() => dispose?.());

  it('projects read-model snapshots once per frame (positive)', () => {
    let notifications = 0;
    const unsub = observabilityStore.subscribe(() => {
      notifications += 1;
    });
    for (const snapshot of fullDeckSnapshots()) feed.emitEvents(snapshot);
    expect(notifications).toBe(0); // nothing lands before the frame
    frames.frame();
    unsub();
    expect(notifications).toBe(1);
    expect(Object.keys(observabilityStore.getState().snapshots)).toHaveLength(10);
  });

  it('event-summary and opaque payloads never reach the store (negative)', () => {
    feed.emitEvents({
      kind: 'event-summary',
      eventId: 1,
      ts: T0,
      account: 'MAX_A',
      backend: 'claude_code',
      source: 'claude-jsonl',
      eventType: 'assistant-turn',
    });
    feed.emitEvents({ kind: 'm4-workstream-lens', opaque: true });
    frames.frame();
    expect(observabilityStore.getState().snapshots).toEqual({});
  });

  it('broker restart flushes then resets every projection (edge)', () => {
    feed.emitEvents(quotaGaugesSnap([src('fresh')]));
    frames.frame();
    expect(latestSnapshot(observabilityStore.getState().snapshots, 'quota-gauges')).toBeDefined();
    feed.emitEvents(quotaGaugesSnap([src('fresh')], undefined, T0 + 1));
    feed.emitRestart(); // pending item flushes, then the boot-scoped reset wins
    expect(observabilityStore.getState().snapshots).toEqual({});
  });

  it('dispose stops intake (edge)', () => {
    dispose?.();
    dispose = undefined;
    feed.emitEvents(quotaGaugesSnap([src('fresh')]));
    frames.frame();
    expect(observabilityStore.getState().snapshots).toEqual({});
  });
});
