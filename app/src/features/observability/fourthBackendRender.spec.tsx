// @vitest-environment jsdom
/**
 * FOURTH-BACKEND RENDER PROOF ([X1] scalability; ICR-0016 backend-registry
 * generalization — the OS-1 finding's FE acceptance test).
 *
 * THE FINDING (docs/reviews/optimization-scalability.md OS-1): adding a new
 * local LLM / backend beyond the built-in three was a cross-codebase fork —
 * the FE face being CLOSED `Record<Backend, string>` engraved-label maps that
 * rendered `undefined` (blank) for a registered fourth backend on the latency
 * / api-equiv / resource-health rows.
 *
 * THE PROOF: register a SYNTHETIC fourth backend descriptor
 * (`SYNTHETIC_BACKEND_DESCRIPTOR` from the testkit), route wire snapshots that
 * carry `backend: 'synthbackend'` through the REAL FE stores, and assert:
 *   1. the ObservabilityDeck latency row renders the DERIVED engraved label
 *      (`SYNTHBACKEND`) — never blank / `undefined`;
 *   2. the ResourceHealthInstrument session + notice rows render it too;
 *   3. NO edit to the deck / instrument was needed — the seam
 *      (`backendLabel`) resolves through the frozen registry;
 *   4. the identifier audit ([X2]) still passes over the rendered markup.
 *
 * The built-in three stay BYTE-IDENTICAL (proven in backendLabels.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  registerBackend,
  unregisterBackend,
  type AccountLabel,
  type Backend,
  type LatencySnapshot,
  type ReadModelSnapshot,
  type ResourceHealthSnapshot,
} from '@aibender/protocol';
import { SYNTHETIC_BACKEND_DESCRIPTOR, assertSynthesizedSafeText } from '@aibender/testkit';
import { backendLabel, connectionStore, quotaStore } from '../../lib/index.ts';
import { ObservabilityDeck } from './ObservabilityDeck.tsx';
import { ResourceHealthInstrument } from './ResourceHealthInstrument.tsx';
import { observabilityStore } from './store.ts';
import { resourceHealthSnap, src, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The synthetic backend + its account label (its descriptor serves `SYNTH_L`).
// Both casts sit at the fixture boundary and mirror the wire reality: the
// TYPES stay the built-in seed unions for the exhaustive built-in call sites,
// while the runtime gates (`isBackend` / `isAccountLabel`) admit the REGISTRY,
// so a registered fourth backend + the label its descriptor serves are legal
// wire values (see packages/protocol/src/vocab.ts BackendId note).
const SYNTH_BACKEND = SYNTHETIC_BACKEND_DESCRIPTOR.id as Backend;
const SYNTH_LABEL = 'SYNTH_L' as unknown as AccountLabel;
// The derived engraved label the seam produces for this id.
const SYNTH_ENGRAVED = 'SYNTHBACKEND';

/**
 * A latency snapshot carrying a fourth-backend row. The `as Backend` at the
 * fixture boundary mirrors the wire reality: `LatencyEntry.backend` is TYPED
 * as the seed union for the exhaustive built-in call sites, but the runtime
 * validator (`isBackend`) admits the REGISTRY, so a registered fourth id is a
 * legal wire value (see packages/protocol/src/vocab.ts BackendId note).
 */
function latencyWithFourthBackend(): LatencySnapshot {
  return {
    kind: 'read-model-snapshot',
    readModel: 'latency',
    capturedAt: T0,
    sources: [src('fresh', 'lmstudio', T0 - 1000)],
    data: {
      entries: [
        { backend: 'lmstudio', p50Ms: 300, p95Ms: 900, ttftP50Ms: 80, ttftP95Ms: 200, sampleCount: 40 },
        { backend: SYNTH_BACKEND, p50Ms: 120, p95Ms: 480, sampleCount: 12 },
      ],
    },
  };
}

/** A resource-health snapshot with a fourth-backend session + shed notice. */
function resourceHealthWithFourthBackend(): ResourceHealthSnapshot {
  return resourceHealthSnap(
    [src('fresh', 'lmstudio', T0 - 1000)],
    {
      pressureLevel: 2,
      pressureState: 'amber',
      freeRamPct: 40,
      swapUsedBytes: 0,
      residentSessionCount: 1,
      sessions: [
        { account: SYNTH_LABEL, backend: SYNTH_BACKEND, slot: 0, footprintMb: 2048, band: 'warn' },
      ],
      notices: [{ action: 'trim-scrollback', at: T0 + 100, account: SYNTH_LABEL, backend: SYNTH_BACKEND }],
    },
  );
}

describe('fourth-backend render — surfaces from the registry with no FE edit [ICR-0016]', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    registerBackend(SYNTHETIC_BACKEND_DESCRIPTOR);
    observabilityStore.getState().reset();
    quotaStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    connectionStore.getState().reset();
    unregisterBackend(SYNTHETIC_BACKEND_DESCRIPTOR.id);
  });

  function textOf(testId: string): string {
    return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
  }

  it('the deck latency row renders the derived engraved label — never blank', () => {
    act(() => observabilityStore.getState().applyBatch([latencyWithFourthBackend() as ReadModelSnapshot]));
    act(() => root.render(<ObservabilityDeck now={() => T0} />));

    // The fourth-backend latency row exists and carries the DERIVED label.
    const row = host.querySelector(`[data-testid="latency-${SYNTH_BACKEND}"]`);
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(SYNTH_ENGRAVED);
    // Regression guard: the seam yields exactly the derived label (not blank,
    // not `undefined`, not the raw id) — the exact pre-ICR-0016 break.
    expect(backendLabel(SYNTH_BACKEND)).toBe(SYNTH_ENGRAVED);
    expect(row?.textContent).not.toContain('undefined');

    // The built-in lmstudio row still reads its canonical short label.
    expect(textOf('latency-lmstudio')).toContain('LMSTUDIO');

    // [X2]: nothing identity-shaped rendered.
    assertSynthesizedSafeText(host.innerHTML);
  });

  it('the resource-health session + notice rows render the fourth backend', () => {
    act(() =>
      observabilityStore.getState().applyBatch([resourceHealthWithFourthBackend() as ReadModelSnapshot]),
    );
    act(() => root.render(<ResourceHealthInstrument now={() => T0 + 1000} />));

    // Session row: engraved label = account + derived backend label + slot.
    const session = textOf(`rh-session-${SYNTH_LABEL}-0`);
    expect(session).toContain(SYNTH_LABEL);
    expect(session).toContain(SYNTH_ENGRAVED);
    expect(session).not.toContain('undefined');

    // Shed-notice row: labelled line carries the derived backend label too.
    const notice = textOf('rh-notice-trim-scrollback');
    expect(notice).toContain(SYNTH_LABEL);
    expect(notice).toContain(SYNTH_ENGRAVED);

    // [X2]: audit passes over the whole instrument.
    assertSynthesizedSafeText(host.innerHTML);
  });
});
