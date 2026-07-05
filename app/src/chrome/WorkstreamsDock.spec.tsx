// @vitest-environment jsdom
/**
 * Left-zone workstreams dock (M4 chrome wiring — the FE-6 mount-point ICR):
 * Positive: whatever occupies the `workstreams` island slot mounts into the
 *           dock through the registry seam (chrome never imports features).
 * Negative: while the slot is empty the dock renders the NO SIGNAL
 *           treatment — a dimmed instrument, never an error.
 * Edge:     late registration mounts reactively; unregistration returns the
 *           dock to NO SIGNAL and runs the island's unmount cleanup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { registerIsland, resetIslandsForTest } from './islandRegistry.ts';
import { WorkstreamsDock } from './WorkstreamsDock.tsx';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkstreamsDock (left zone, registry seam)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetIslandsForTest();
  });

  const render = () => act(() => root.render(<WorkstreamsDock />));

  it('renders NO SIGNAL while the slot is empty — never an error (negative)', () => {
    render();
    expect(container.querySelector('[data-testid="workstreams-nosignal"]')).not.toBeNull();
    expect(container.textContent).toContain('NO SIGNAL');
    expect(container.textContent).toContain('NO LINEAGE ISLAND REGISTERED');
  });

  it('mounts the registered island with a session-free context (positive)', () => {
    const mounts: { sessionId: string | undefined }[] = [];
    registerIsland('workstreams', {
      mount(host, context) {
        mounts.push(context);
        host.textContent = 'SYNTH LINEAGE DECK';
        return () => {
          host.textContent = '';
        };
      },
    });
    render();
    expect(mounts).toEqual([{ sessionId: undefined }]);
    expect(container.textContent).toContain('SYNTH LINEAGE DECK');
    expect(container.querySelector('[data-testid="workstreams-nosignal"]')).toBeNull();
  });

  it('late registration mounts reactively; unregistration cleans up (edge)', () => {
    render();
    expect(container.textContent).toContain('NO SIGNAL');

    let unmounts = 0;
    let unregister: (() => void) | undefined;
    act(() => {
      unregister = registerIsland('workstreams', {
        mount() {
          return () => {
            unmounts += 1;
          };
        },
      });
    });
    expect(container.querySelector('[data-testid="workstreams-host"]')).not.toBeNull();

    act(() => unregister?.());
    expect(unmounts).toBe(1);
    expect(container.querySelector('[data-testid="workstreams-nosignal"]')).not.toBeNull();
  });
});
