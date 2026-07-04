/**
 * FE-3 renderer selection — the SPIKE-A `attachRenderer()` contract,
 * implemented verbatim (docs/spikes/spike-a-webview-render.md, "The
 * renderer-detection contract FE-3 must implement", clauses 1–8).
 *
 * xterm 6 has NO canvas renderer: the WebGL addon is the preferred renderer
 * and the DOM renderer is the built-in default — "fallback" is simply not
 * loading (or disposing) the addon. The spike proved the full chain in
 * WebKit 26.5: addon load → simulated context loss → addon's internal 3 s
 * restoration grace → `onContextLoss` → dispose → DOM renderer, with zero
 * buffer loss (the buffer is CPU-side, clause 4).
 *
 * Clause map:
 *  1. `forceDom` override → `{mode:'dom', reason:'forced-dom'}`.
 *  2. Try-throw selection; `onContextLoss` subscribed BEFORE `loadAddon`.
 *  3. Context loss → dispose exactly once → permanent DOM (no re-attempt,
 *     no flapping) → `onFallback`.
 *  4. No save/restore in the fallback path — renderer swap only.
 *  5. Reattach re-runs this function from clause 1 (a fresh attach may
 *     succeed at WebGL even if a prior one fell back).
 *  6. Optional raw `webglcontextlost` early-notice hook (`onDegraded`) for
 *     the ≤3 s stale-canvas window — advisory only, never blocking.
 *  7. One telemetry event per selection/fallback: `{mode, reason, detail?}`
 *     — session/file scope only, no account identifiers [X2].
 *  8. Test signals: WebGL active ⇔ canvases present and `.xterm-rows`
 *     absent/empty; DOM active ⇔ `.xterm-rows` populated; secondary signal
 *     `addon.textureAtlas != null` (exercised by the pw/ component tests).
 */

import { WebglAddon } from '@xterm/addon-webgl';

export type RendererMode = 'webgl' | 'dom';
export type RendererReason = 'webgl-ok' | 'webgl-throw' | 'context-loss' | 'forced-dom';

/**
 * Structural slice of `@xterm/addon-webgl`'s WebglAddon the contract needs —
 * kept structural so unit tests can drive the selection logic with fakes
 * (the real class satisfies it).
 */
export interface WebglAddonLike {
  onContextLoss(listener: () => void): unknown;
  dispose(): void;
  readonly textureAtlas?: unknown;
}

/** Structural slice of xterm's Terminal used by the selection logic. */
export interface RendererTerminal {
  loadAddon(addon: WebglAddonLike): void;
  readonly element?: HTMLElement | undefined;
}

/**
 * Live selection state. Returned synchronously by {@link attachRenderer};
 * MUTATED in place if a runtime context loss later degrades the attach to
 * the DOM renderer (`onFallback` receives the same object).
 */
export interface RendererSelection {
  mode: RendererMode;
  reason: RendererReason;
  /** null when mode === 'dom'. */
  webglAddon: WebglAddonLike | null;
  /** Throw message — telemetry only, never rendered. */
  detail?: string;
}

/** Clause 7 — one event per selection/fallback. Identifier-free [X2]. */
export interface RendererTelemetryEvent {
  readonly mode: RendererMode;
  readonly reason: RendererReason;
  readonly detail?: string;
}

export interface AttachRendererOptions {
  /** Clause 1: settings/env override — skip WebGL entirely. */
  forceDom?: boolean;
  /** Clause 3: invoked once if a context loss degrades this attach to DOM. */
  onFallback?: (selection: RendererSelection) => void;
  /** Clause 7: collector hook — one call per selection/fallback event. */
  onTelemetry?: (event: RendererTelemetryEvent) => void;
  /**
   * Clause 6 (optional polish): early "renderer degraded" notice from the
   * raw `webglcontextlost` event on the addon's canvas — may fire up to ~3 s
   * before the addon's grace window elapses. Advisory; never block on it.
   */
  onDegraded?: () => void;
  /** DI seam for tests; defaults to the real `@xterm/addon-webgl` class. */
  createWebglAddon?: () => WebglAddonLike;
}

function defaultCreateWebglAddon(): WebglAddonLike {
  return new WebglAddon();
}

/**
 * Call once per terminal attach (and again on every reattach — clause 5).
 * The terminal must already be `open()`ed so addon load can bind a canvas.
 */
export function attachRenderer(
  term: RendererTerminal,
  opts: AttachRendererOptions = {},
): RendererSelection {
  const emit = (selection: RendererSelection): void => {
    if (!opts.onTelemetry) return;
    const event: RendererTelemetryEvent =
      selection.detail === undefined
        ? { mode: selection.mode, reason: selection.reason }
        : { mode: selection.mode, reason: selection.reason, detail: selection.detail };
    opts.onTelemetry(event);
  };

  // Clause 1 — override first.
  if (opts.forceDom === true) {
    const selection: RendererSelection = { mode: 'dom', reason: 'forced-dom', webglAddon: null };
    emit(selection);
    return selection;
  }

  // Clause 2 — try-throw selection.
  let addon: WebglAddonLike | null = null;
  let disposed = false;
  const disposeOnce = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      addon?.dispose();
    } catch {
      // A throwing dispose must never take the DOM fallback down with it.
    }
  };

  const selection: RendererSelection = { mode: 'webgl', reason: 'webgl-ok', webglAddon: null };

  try {
    addon = (opts.createWebglAddon ?? defaultCreateWebglAddon)();
    // Subscribe BEFORE loadAddon (clause 2): the addon fires onContextLoss
    // only after its internal 3 s restoration grace window (clause 3).
    addon.onContextLoss(() => {
      if (disposed) return; // dispose exactly once; loss after fallback is inert
      disposeOnce();
      selection.mode = 'dom';
      selection.reason = 'context-loss';
      selection.webglAddon = null;
      // Clause 3: NO WebGL re-attempt within this attach — degrade permanently.
      emit(selection);
      opts.onFallback?.(selection);
    });
    term.loadAddon(addon);
  } catch (err) {
    disposeOnce();
    selection.mode = 'dom';
    selection.reason = 'webgl-throw';
    selection.webglAddon = null;
    selection.detail = err instanceof Error ? err.message : String(err);
    emit(selection);
    return selection;
  }

  selection.webglAddon = addon;

  // Clause 6 — optional early stale-canvas notice (raw event, pre-grace).
  if (opts.onDegraded && term.element) {
    for (const canvas of Array.from(term.element.querySelectorAll('canvas'))) {
      canvas.addEventListener('webglcontextlost', () => opts.onDegraded?.(), { once: true });
    }
  }

  emit(selection);
  return selection;
}
