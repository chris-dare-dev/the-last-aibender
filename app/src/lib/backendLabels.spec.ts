/**
 * FE backend-label seam ([X1] scalability; ICR-0016 backend-registry
 * generalization — the OS-1 finding's FE face).
 *
 * The claim under test: the engraved backend label is resolved through the
 * frozen backend REGISTRY, not a closed `Record<Backend, string>`.
 *
 * Positive: the three built-ins render their canonical short labels
 *           BYTE-IDENTICAL to the pre-ICR-0016 closed maps.
 * Extensibility: a synthetic FOURTH backend, registered via `registerBackend`,
 *           renders a derived label — with NO edit to this seam. This is the
 *           exact break the finding names: before ICR-0016 a 4th backend
 *           indexed the closed record and read `undefined` (blank).
 * [X2]: a derived label is a mechanical uppercasing of a REGISTERED generic
 *           backend id — never identity-shaped.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKENDS,
  registerBackend,
  unregisterBackend,
  type BackendDescriptor,
} from '@aibender/protocol';
import { SYNTHETIC_BACKEND_DESCRIPTOR } from '@aibender/testkit';
import { BUILTIN_BACKEND_LABELS, backendLabel } from './backendLabels.ts';

afterEach(() => {
  // Registry hygiene: never leak a synthetic backend across specs.
  unregisterBackend(SYNTHETIC_BACKEND_DESCRIPTOR.id);
});

describe('backendLabel — registry-driven engraved label (ICR-0016)', () => {
  it('renders the three built-ins byte-identically to the old closed map', () => {
    expect(backendLabel('claude_code')).toBe('CLAUDE');
    expect(backendLabel('opencode')).toBe('OPENCODE');
    expect(backendLabel('lmstudio')).toBe('LMSTUDIO');
  });

  it('the built-in label map covers exactly the seed three (no drift)', () => {
    expect(Object.keys(BUILTIN_BACKEND_LABELS).sort()).toEqual([...BACKENDS].sort());
  });

  it('renders a registered FOURTH backend with a derived label — no seam edit', () => {
    // Before registration the id is unknown; the seam still derives (never
    // blank / undefined) so a stale wire row cannot render an empty label.
    expect(backendLabel(SYNTHETIC_BACKEND_DESCRIPTOR.id)).toBe('SYNTHBACKEND');

    registerBackend(SYNTHETIC_BACKEND_DESCRIPTOR);
    // Registered: the fourth backend surfaces its derived engraved label.
    expect(backendLabel(SYNTHETIC_BACKEND_DESCRIPTOR.id)).toBe('SYNTHBACKEND');
  });

  it('derives an underscore-preserving, uppercased, character-grid-safe label', () => {
    const descriptor: BackendDescriptor = Object.freeze({
      id: 'local_qwen',
      servesLabel: (label: string) => label === 'SYNTH_Q',
      sourceName: 'lmstudio',
      substrates: Object.freeze(['sdk'] as const),
      builtin: false,
    });
    registerBackend(descriptor);
    try {
      expect(backendLabel('local_qwen')).toBe('LOCAL_QWEN');
    } finally {
      unregisterBackend('local_qwen');
    }
  });

  it('never emits identity-shaped text for any derived label [X2]', () => {
    // A derived label is a mechanical uppercasing of a registered generic id;
    // it can never contain an email/12-digit/token shape.
    const label = backendLabel('local_qwen');
    expect(label).not.toMatch(/@/);
    expect(label).not.toMatch(/\d{12}/);
    expect(label).not.toMatch(/\bsk-/i);
  });
});
