/**
 * SPIKE-A attachRenderer contract — unit coverage of all 8 clauses with
 * fake terminal/addon (plan §9.2 FE-3: negative row "WebGL context lost →
 * DOM fallback without data loss" is exercised end-to-end in pw/run-pw.ts;
 * here the selection/dispose/telemetry state machine is pinned).
 */

import { describe, expect, it } from 'vitest';
import {
  attachRenderer,
  type RendererSelection,
  type RendererTelemetryEvent,
  type RendererTerminal,
  type WebglAddonLike,
} from './renderer.ts';

class FakeAddon implements WebglAddonLike {
  disposeCalls = 0;
  lossListener: (() => void) | null = null;
  readonly textureAtlas = { fake: true };

  onContextLoss(listener: () => void): void {
    this.lossListener = listener;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

interface FakeTermEventLog {
  events: string[];
}

function fakeTerm(log: FakeTermEventLog, opts: { throwOnLoad?: boolean } = {}): RendererTerminal {
  return {
    loadAddon(): void {
      log.events.push('load');
      if (opts.throwOnLoad === true) throw new Error('synthetic load failure');
    },
    element: undefined,
  };
}

describe('attachRenderer (SPIKE-A contract)', () => {
  it('clause 1: forceDom skips WebGL entirely', () => {
    const log: FakeTermEventLog = { events: [] };
    let constructed = 0;
    const telemetry: RendererTelemetryEvent[] = [];
    const sel = attachRenderer(fakeTerm(log), {
      forceDom: true,
      createWebglAddon: () => {
        constructed += 1;
        return new FakeAddon();
      },
      onTelemetry: (e) => telemetry.push(e),
    });
    expect(sel).toEqual({ mode: 'dom', reason: 'forced-dom', webglAddon: null });
    expect(constructed).toBe(0);
    expect(log.events).toEqual([]);
    expect(telemetry).toEqual([{ mode: 'dom', reason: 'forced-dom' }]);
  });

  it('clause 2: healthy load selects webgl and subscribes onContextLoss BEFORE loadAddon', () => {
    const log: FakeTermEventLog = { events: [] };
    const addon = new FakeAddon();
    const origOnContextLoss = addon.onContextLoss.bind(addon);
    addon.onContextLoss = (listener) => {
      log.events.push('subscribe');
      origOnContextLoss(listener);
    };
    const telemetry: RendererTelemetryEvent[] = [];
    const sel = attachRenderer(fakeTerm(log), {
      createWebglAddon: () => addon,
      onTelemetry: (e) => telemetry.push(e),
    });
    expect(sel.mode).toBe('webgl');
    expect(sel.reason).toBe('webgl-ok');
    expect(sel.webglAddon).toBe(addon);
    expect(log.events).toEqual(['subscribe', 'load']); // order is the clause
    expect(telemetry).toEqual([{ mode: 'webgl', reason: 'webgl-ok' }]);
  });

  it('clause 2: construction throw falls back to dom with detail', () => {
    const log: FakeTermEventLog = { events: [] };
    const sel = attachRenderer(fakeTerm(log), {
      createWebglAddon: () => {
        throw new Error('no webgl2 context');
      },
    });
    expect(sel.mode).toBe('dom');
    expect(sel.reason).toBe('webgl-throw');
    expect(sel.webglAddon).toBeNull();
    expect(sel.detail).toBe('no webgl2 context');
    expect(log.events).toEqual([]);
  });

  it('clause 2: loadAddon throw discards the addon and falls back', () => {
    const log: FakeTermEventLog = { events: [] };
    const addon = new FakeAddon();
    const sel = attachRenderer(fakeTerm(log, { throwOnLoad: true }), {
      createWebglAddon: () => addon,
    });
    expect(sel).toMatchObject({ mode: 'dom', reason: 'webgl-throw', webglAddon: null });
    expect(sel.detail).toBe('synthetic load failure');
    expect(addon.disposeCalls).toBe(1);
  });

  it('clause 3: context loss disposes exactly once, flips the live selection, fires onFallback', () => {
    const log: FakeTermEventLog = { events: [] };
    const addon = new FakeAddon();
    const fallbacks: RendererSelection[] = [];
    const telemetry: RendererTelemetryEvent[] = [];
    const sel = attachRenderer(fakeTerm(log), {
      createWebglAddon: () => addon,
      onFallback: (s) => fallbacks.push(s),
      onTelemetry: (e) => telemetry.push(e),
    });
    expect(sel.mode).toBe('webgl');

    addon.lossListener?.();
    expect(sel.mode).toBe('dom');
    expect(sel.reason).toBe('context-loss');
    expect(sel.webglAddon).toBeNull();
    expect(addon.disposeCalls).toBe(1);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toBe(sel); // the SAME live selection object
    expect(telemetry).toEqual([
      { mode: 'webgl', reason: 'webgl-ok' },
      { mode: 'dom', reason: 'context-loss' },
    ]);

    // Clause 3 no-reflap: a second loss event is inert — no re-dispose,
    // no second fallback, selection stays dom.
    addon.lossListener?.();
    expect(addon.disposeCalls).toBe(1);
    expect(fallbacks).toHaveLength(1);
    expect(sel.mode).toBe('dom');
  });

  it('clause 5: reattach re-runs selection from scratch — a fresh attach may regain webgl', () => {
    const log: FakeTermEventLog = { events: [] };
    const first = new FakeAddon();
    const sel1 = attachRenderer(fakeTerm(log), { createWebglAddon: () => first });
    first.lossListener?.();
    expect(sel1.mode).toBe('dom');

    const second = new FakeAddon();
    const sel2 = attachRenderer(fakeTerm(log), { createWebglAddon: () => second });
    expect(sel2.mode).toBe('webgl');
    expect(sel2.webglAddon).toBe(second);
    expect(sel1.mode).toBe('dom'); // first attach's state is untouched
  });

  it('clause 7: telemetry events carry mode/reason/detail only (identifier-free shape)', () => {
    const telemetry: RendererTelemetryEvent[] = [];
    attachRenderer(fakeTerm({ events: [] }), {
      createWebglAddon: () => {
        throw new Error('synthetic');
      },
      onTelemetry: (e) => telemetry.push(e),
    });
    expect(telemetry).toHaveLength(1);
    expect(Object.keys(telemetry[0] as object).sort()).toEqual(['detail', 'mode', 'reason']);
  });

  it('tolerates a throwing dispose during the loss path (fallback still lands)', () => {
    const addon = new FakeAddon();
    addon.dispose = () => {
      addon.disposeCalls += 1;
      throw new Error('dispose exploded');
    };
    const sel = attachRenderer(fakeTerm({ events: [] }), { createWebglAddon: () => addon });
    addon.lossListener?.();
    expect(sel.mode).toBe('dom');
    expect(sel.reason).toBe('context-loss');
  });
});
