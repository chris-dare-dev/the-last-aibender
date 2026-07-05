// @vitest-environment jsdom
/**
 * Supervision instrument render AUDIT (plan §9.2 FE M6 negative row; [X2]).
 *
 * The claim under audit: across the pressure gauge, per-session footprints and
 * every shed/recycle STATE, the rendered markup never contains an
 * identity-shaped string, account references render ONLY as the frozen
 * placeholder labels, and no off-token color leaks through a style attribute.
 * The wire is labels + numbers only, so there is nothing to shape-mask —
 * this audit proves the RENDER never fabricates or leaks one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ACCOUNT_LABELS } from '@aibender/protocol';
import { assertSynthesizedSafeText } from '@aibender/testkit';
import { connectionStore } from '../../lib/index.ts';
import { ResourceHealthInstrument } from './ResourceHealthInstrument.tsx';
import { observabilityStore } from './store.ts';
import { resourceHealthRedSnap, src, T0 } from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('supervision render audit — labels + numbers only [X2]', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    observabilityStore.getState().reset();
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
  });

  function render(): void {
    act(() => {
      root.render(<ResourceHealthInstrument now={() => T0 + 1000} />);
    });
  }

  it('screens the full red-pressure instrument through the identity-shape guard', () => {
    act(() =>
      observabilityStore.getState().applyBatch([resourceHealthRedSnap([src('fresh', 'lmstudio', T0)])]),
    );
    render();
    assertSynthesizedSafeText(host.innerHTML);
  });

  it('every session/notice account renders only as a frozen placeholder label', () => {
    act(() =>
      observabilityStore.getState().applyBatch([resourceHealthRedSnap([src('fresh', 'lmstudio', T0)])]),
    );
    render();
    const sessionRows = [...host.querySelectorAll('[data-testid^="rh-session-"]')];
    expect(sessionRows.length).toBeGreaterThan(0);
    for (const el of sessionRows) {
      const label = (el.getAttribute('data-testid') ?? '').split('-')[2];
      expect(ACCOUNT_LABELS as readonly string[]).toContain(label ?? '');
    }
    // The recycle notice's account is a frozen label too.
    expect(host.querySelector('[data-testid="rh-notice-recycle-session"]')?.textContent).toContain(
      'MAX_A',
    );
  });

  it('never uses an off-token color in any rendered style attribute', () => {
    act(() =>
      observabilityStore.getState().applyBatch([resourceHealthRedSnap([src('fresh', 'lmstudio', T0)])]),
    );
    render();
    for (const el of host.querySelectorAll('[style]')) {
      const style = el.getAttribute('style') ?? '';
      // The only inline style is the pressure gauge fill WIDTH (a layout
      // percentage) — never a color, hue or gradient.
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(style).not.toMatch(/(?<![a-zA-Z-])(?:rgba?|hsla?|oklch|oklab)\(/);
      expect(style).toMatch(/^width:/);
    }
  });

  it('a shed/recycle is a STATE, never a toast/alert element', () => {
    act(() =>
      observabilityStore.getState().applyBatch([resourceHealthRedSnap([src('fresh', 'lmstudio', T0)])]),
    );
    render();
    // No ARIA alert/toast anywhere — shed/recycle are engraved rows.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    // The notices live INSIDE the single instrument section.
    const notices = [...host.querySelectorAll('[data-testid^="rh-notice-"]')];
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice.closest('[data-instrument="resource-health"]')).not.toBeNull();
    }
  });
});
