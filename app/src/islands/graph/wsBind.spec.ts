/**
 * FE-4 wire binding — context-graph payloads reach the island sink exactly
 * once; other channels never leak in; broker restarts surface as the
 * stale-projection signal.
 */

import { describe, expect, it } from 'vitest';
import type { ContextGraphTouch } from '@aibender/protocol';
import type { ClientEvents } from '../../lib/index.ts';
import { bindGraphFeed } from './wsBind.ts';

function fakeClient() {
  const listeners = new Set<ClientEvents>();
  return {
    listeners,
    subscribe(listener: ClientEvents): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(message: unknown): void {
      for (const l of listeners) l.onMessage?.(message as never);
    },
    restart(): void {
      for (const l of listeners) l.onBrokerRestart?.();
    },
  };
}

const touch: ContextGraphTouch = {
  kind: 'context-touch',
  sessionId: 'ses-a',
  path: '/synthetic/p/a.md',
  relation: 'read',
  ts: 1,
};

describe('bindGraphFeed', () => {
  it('forwards context-graph payloads to the sink, one call per touch', () => {
    const client = fakeClient();
    const seen: ContextGraphTouch[][] = [];
    bindGraphFeed(client, { applyTouches: (t) => seen.push([...t]) });
    client.push({ kind: 'context-graph', channel: 'context-graph', seq: 1, payload: touch });
    client.push({ kind: 'context-graph', channel: 'context-graph', seq: 2, payload: touch });
    expect(seen).toEqual([[touch], [touch]]);
  });

  it('ignores every other channel kind', () => {
    const client = fakeClient();
    const seen: unknown[] = [];
    bindGraphFeed(client, { applyTouches: (t) => seen.push(t) });
    client.push({ kind: 'quota', channel: 'quota', seq: 1, payload: {} });
    client.push({ kind: 'transcript', channel: 't', sessionId: 's', seq: 1, payload: {} });
    client.push({ kind: 'events', channel: 'events', seq: 1, payload: { opaque: true } });
    expect(seen).toEqual([]);
  });

  it('surfaces broker restarts through the option hook', () => {
    const client = fakeClient();
    let restarts = 0;
    bindGraphFeed(client, { applyTouches: () => undefined }, { onBrokerRestart: () => (restarts += 1) });
    client.restart();
    expect(restarts).toBe(1);
  });

  it('dispose unsubscribes — later traffic never reaches the sink', () => {
    const client = fakeClient();
    const seen: unknown[] = [];
    const off = bindGraphFeed(client, { applyTouches: (t) => seen.push(t) });
    off();
    client.push({ kind: 'context-graph', channel: 'context-graph', seq: 1, payload: touch });
    expect(seen).toEqual([]);
    expect(client.listeners.size).toBe(0);
  });
});
