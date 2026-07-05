// @vitest-environment jsdom
/**
 * THE ONE ceremonial animation (DESIGN.md §3.3 — `ceremony-lineage`):
 * Positive: a ledger-committed lineage edge EVENT draws itself (the animated
 *           edge register) and lights the terminal node ring; a later event
 *           re-arms with a fresh epoch (remount key).
 * Negative: snapshot-carried edges render settled; node upserts, briefs,
 *           advisories and merge resolutions never trigger ceremony — the
 *           motion budget is spent on lineage events ONLY.
 * Edge:     prefers-reduced-motion renders the §3.5 DISCRETE variant — no
 *           animated registers; a static amber ring for the 1200 ms budget,
 *           reverted in one step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { connectionStore } from '../../lib/index.ts';
import { workstreamsStore } from './store.ts';
import { CEREMONY_BUDGET_MS, WorkstreamsDeck } from './WorkstreamsDeck.tsx';
import {
  advisory,
  brief,
  detailSnap,
  edgeEvent,
  listSnap,
  nodeEvent,
  nodeRecord,
  summary,
  T0,
} from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MediaListener = () => void;

/** Deterministic matchMedia stub (jsdom's is static). */
function stubMatchMedia(reduced: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: (_type: string, _l: MediaListener) => undefined,
    removeEventListener: (_type: string, _l: MediaListener) => undefined,
  });
}

describe('ceremony-lineage', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    workstreamsStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    stubMatchMedia(false);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    connectionStore.getState().reset();
    vi.useRealTimers();
  });

  function renderDeck(): void {
    act(() => {
      root.render(<WorkstreamsDeck />);
    });
  }

  function seedGraph(): void {
    act(() =>
      workstreamsStore.getState().applyBatch([
        listSnap([summary('ws_c')], 0),
        nodeEvent('ses_a', { workstreamId: 'ws_c', createdAt: T0 }),
        nodeEvent('ses_b', { workstreamId: 'ws_c', createdAt: T0 + 1 }),
        nodeEvent('ses_c', { workstreamId: 'ws_c', createdAt: T0 + 2 }),
      ]),
    );
  }

  it('a lineage edge EVENT arms the animated edge + ring registers', () => {
    seedGraph();
    renderDeck();
    act(() => workstreamsStore.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]));

    const path = host.querySelector('[data-testid="ws-edge-edg_1"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('data-ceremony')).toBe('true');
    expect(path?.getAttribute('class')).toContain('ig-ws-ceremony-edge');
    const ring = host.querySelector('[data-testid="ws-node-ses_b"] .ig-ws-node-ring');
    expect(ring?.getAttribute('class')).toContain('ig-ws-ceremony-ring');
    // The origin node ring stays at rest.
    const originRing = host.querySelector('[data-testid="ws-node-ses_a"] .ig-ws-node-ring');
    expect(originRing?.getAttribute('class')).not.toContain('ig-ws-ceremony-ring');
  });

  it('a later lineage event MOVES the ceremony (newest only, fresh epoch)', () => {
    seedGraph();
    renderDeck();
    act(() => workstreamsStore.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]));
    const epoch1 = workstreamsStore.getState().ceremony?.epoch;
    act(() =>
      workstreamsStore.getState().applyBatch([edgeEvent('edg_2', 'ses_b', 'ses_c', { ts: T0 + 5 })]),
    );
    expect(workstreamsStore.getState().ceremony?.epoch).toBe((epoch1 ?? 0) + 1);
    expect(
      host.querySelector('[data-testid="ws-edge-edg_1"]')?.getAttribute('data-ceremony'),
    ).toBe('false');
    expect(
      host.querySelector('[data-testid="ws-edge-edg_2"]')?.getAttribute('data-ceremony'),
    ).toBe('true');
  });

  it('snapshot-carried edges render settled — never ceremonial (negative)', () => {
    act(() =>
      workstreamsStore.getState().applyBatch([
        listSnap([summary('ws_c')], 0),
        detailSnap(
          summary('ws_c'),
          [
            nodeRecord('ses_a', { workstreamId: 'ws_c', createdAt: T0 }),
            nodeRecord('ses_b', { workstreamId: 'ws_c', createdAt: T0 + 1 }),
          ],
          [edgeEvent('edg_snap', 'ses_a', 'ses_b')],
        ),
      ]),
    );
    renderDeck();
    const path = host.querySelector('[data-testid="ws-edge-edg_snap"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('data-ceremony')).toBe('false');
    expect(host.querySelector('.ig-ws-ceremony-ring')).toBeNull();
  });

  it('nodes, briefs, advisories and merge resolutions never fire it (negative)', () => {
    seedGraph();
    renderDeck();
    act(() =>
      workstreamsStore.getState().applyBatch([
        nodeEvent('ses_a', { workstreamId: 'ws_c', state: 'completed', createdAt: T0 }),
        brief('br_1', ['ses_a']),
        advisory('ses_a'),
        { kind: 'workstream-merge-resolved', mergeId: 'mrg_1', sessionId: 'ses_c', briefId: 'br_m' },
      ]),
    );
    expect(host.querySelector('.ig-ws-ceremony-edge')).toBeNull();
    expect(host.querySelector('.ig-ws-ceremony-ring')).toBeNull();
    expect(host.querySelector('[data-ceremony="true"]')).toBeNull();
  });

  it('reduced motion: discrete static ring for the budget, one-step revert (§3.5)', () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    seedGraph();
    renderDeck();
    act(() => workstreamsStore.getState().applyBatch([edgeEvent('edg_1', 'ses_a', 'ses_b')]));

    // No animated registers under reduced motion…
    expect(host.querySelector('.ig-ws-ceremony-edge')).toBeNull();
    expect(host.querySelector('.ig-ws-ceremony-ring')).toBeNull();
    // …the DISCRETE variant instead: a static amber ring on the target node.
    const row = host.querySelector('[data-testid="ws-node-ses_b"]');
    expect(row?.getAttribute('data-ceremony-static')).toBe('true');

    // One step back to rest after the 1200 ms budget — no tween.
    act(() => {
      vi.advanceTimersByTime(CEREMONY_BUDGET_MS + 1);
    });
    expect(row?.getAttribute('data-ceremony-static')).toBe('false');
  });
});
