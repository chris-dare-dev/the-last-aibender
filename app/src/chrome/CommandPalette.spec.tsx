// @vitest-environment jsdom
/**
 * Command palette — ⌘K summon, verb-first fuzzy match, frequency ranking,
 * keyboard-only operation (DESIGN.md §6 + §9 keyboard reachability).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { rankCommands, recordUse, registerCommands, resetCommandsForTest } from './commands.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { uiStore } from './uiStore.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('command ranking', () => {
  beforeEach(() => {
    resetCommandsForTest();
  });

  it('fuzzy-matches verb-first and ranks frequency higher on ties', () => {
    const runs: string[] = [];
    registerCommands([
      { id: 'a', title: 'launch prompt on MAX_B', run: () => runs.push('a') },
      { id: 'b', title: 'launch prompt on MAX_A', run: () => runs.push('b') },
      { id: 'c', title: 'open settings', run: () => runs.push('c') },
    ]);
    // Equal fuzzy scores fall back to the stable title tiebreak (A before B).
    expect(rankCommands('lp max').map((c) => c.id)).toEqual(['b', 'a']);
    // Frequency: use MAX_A twice — it must outrank its sibling now.
    recordUse('b');
    recordUse('b');
    expect(rankCommands('launch').map((c) => c.id)[0]).toBe('b');
    // Negative: nonsense query matches nothing.
    expect(rankCommands('zzzz-no-such-verb')).toHaveLength(0);
  });
});

describe('CommandPalette component', () => {
  let root: Root;
  let host: HTMLElement;
  const runs: string[] = [];

  beforeEach(() => {
    resetCommandsForTest();
    runs.length = 0;
    uiStore.setState({ paletteOpen: false });
    registerCommands([
      { id: 'settings', title: 'open settings', run: () => runs.push('settings') },
      { id: 'reconnect', title: 'reconnect gateway', run: () => runs.push('reconnect') },
    ]);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<CommandPalette />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function press(key: string, init: KeyboardEventInit = {}): void {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });
  }

  it('summons on ⌘K and dismisses on Escape', () => {
    expect(host.querySelector('[data-testid="command-palette"]')).toBeNull();
    press('k', { metaKey: true });
    expect(host.querySelector('[data-testid="command-palette"]')).not.toBeNull();

    const input = host.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="command-palette"]')).toBeNull();
  });

  it('two keystrokes to a verb: type, Enter — the command runs, palette closes', () => {
    press('k', { metaKey: true });
    const input = host.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
    act(() => {
      // React 19 onChange rides the native input event.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'recon');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(runs).toEqual(['reconnect']);
    expect(host.querySelector('[data-testid="command-palette"]')).toBeNull();
  });

  it('arrow keys move the fixed-position selection', () => {
    press('k', { metaKey: true });
    const input = host.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const selected = host.querySelector('.ig-palette-row[data-selected="true"]');
    expect(selected).not.toBeNull();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(runs).toHaveLength(1);
  });
});
