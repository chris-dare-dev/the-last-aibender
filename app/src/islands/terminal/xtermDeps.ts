/**
 * Real-environment wiring for the terminal island: xterm 6 + the locked
 * addon set (webgl via renderer.ts, fit, serialize — blueprint §8 dependency
 * table). This module is the ONLY place the island touches the real xterm
 * classes, so terminalIsland.ts stays unit-testable in Node with fakes.
 *
 * NOTE for composition (FE-2 chrome): the consumer bundle must include
 * `@xterm/xterm/css/xterm.css` and the generated Instrument Grade
 * `tokens.css` (the island reads `--ig-*` at init — DESIGN.md §8.5).
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { attachRenderer } from './renderer.ts';
import { readTerminalTokenTheme } from './theme.ts';
import {
  createTerminalIsland,
  type IslandTerminal,
  type TerminalIslandDeps,
  type TerminalIslandHandle,
  type TerminalIslandOptions,
} from './terminalIsland.ts';

function defaultScheduleFlush(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
  } else {
    setTimeout(callback, 16);
  }
}

function defaultObserveResize(target: HTMLElement, callback: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => undefined;
  const observer = new ResizeObserver(() => callback());
  observer.observe(target);
  return () => observer.disconnect();
}

/** Production deps: real xterm, real addons, rAF ack coalescing. */
export function createDefaultTerminalIslandDeps(): TerminalIslandDeps {
  return {
    createTerminal: (init) =>
      new Terminal({
        scrollback: init.scrollback,
        theme: init.theme,
        ...(init.fontFamily !== undefined ? { fontFamily: init.fontFamily } : {}), // token value from var(--ig-font-mono) via getComputedStyle (DESIGN.md §8.5)
        ...(init.fontSize !== undefined ? { fontSize: init.fontSize } : {}),
      }) as unknown as IslandTerminal,
    createFitAddon: () => new FitAddon(),
    createSerializeAddon: () => new SerializeAddon(),
    attachRenderer,
    readTheme: readTerminalTokenTheme,
    scheduleFlush: defaultScheduleFlush,
    observeResize: defaultObserveResize,
  };
}

/** Mount a terminal island with the real environment. */
export function mountTerminalIsland(
  options: Omit<TerminalIslandOptions, 'deps'>,
): TerminalIslandHandle {
  return createTerminalIsland({ ...options, deps: createDefaultTerminalIslandDeps() });
}
