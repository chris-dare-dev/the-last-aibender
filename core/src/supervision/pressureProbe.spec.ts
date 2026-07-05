/**
 * BE-9 pressure-delta health signals (plan §9.2 BE-9 row):
 *   positive — pressure deltas drive amber/red at the documented thresholds;
 *   negative — naive-free-RAM inputs are rejected BY DESIGN (there is no API
 *              that takes bare free RAM → band; the pageout DELTA dominates);
 *   edge     — amber/red hysteresis (no flapping); a no-signal probe holds.
 *
 * The probe is a FAKE — the real macOS reader (createSpawnPressureProbe) is
 * never invoked here.
 */

import { describe, expect, it } from 'vitest';

import { createPressureMonitor, createSpawnPressureProbe } from './pressureProbe.js';
import type { PressureProbe, PressureReading } from './types.js';

const GIB = 1024 * 1024 * 1024;

function fakeProbe(readings: readonly (PressureReading | undefined)[]): PressureProbe {
  let i = 0;
  return { read: () => readings[Math.min(i++, readings.length - 1)] };
}

const calm: PressureReading = { pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 0 };

describe('BE-9 pressure monitor — amber/red at the blueprint §11 thresholds (positive)', () => {
  it('level 2 → amber; level 4 → red', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([
        { ...calm, pressureLevel: 2 },
        { ...calm, pressureLevel: 4 },
      ]),
    });
    expect(m.evaluate().state).toBe('amber');
    expect(m.evaluate().state).toBe('red');
  });

  it('free RAM <25% → amber; <12% → red', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([
        { ...calm, freeRamPct: 24 },
        { ...calm, freeRamPct: 11 },
      ]),
    });
    expect(m.evaluate().state).toBe('amber');
    expect(m.evaluate().state).toBe('red');
  });

  it('swap >20 GB → amber; >26 GB → red', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([
        { ...calm, swapUsedBytes: 21 * GIB },
        { ...calm, swapUsedBytes: 27 * GIB },
      ]),
    });
    expect(m.evaluate().state).toBe('amber');
    expect(m.evaluate().state).toBe('red');
  });
});

describe('BE-9 pressure monitor — the DELTA dominates (never naive free RAM)', () => {
  it('a non-zero pageout DELTA forces at least amber even with comfortable free RAM', () => {
    // free RAM is a comfortable 60% and swap is 0 — a naive free-RAM reading
    // would say "normal". The pageout DELTA says otherwise → amber.
    const m = createPressureMonitor({
      probe: fakeProbe([{ pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 5 }]),
    });
    expect(m.evaluate().state).toBe('amber');
  });

  it('a heavy sustained pageout rate forces red regardless of free RAM', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([{ pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 5000 }]),
    });
    expect(m.evaluate().state).toBe('red');
  });

  it('the API shape makes naive-free-RAM-only input impossible to construct (design)', () => {
    // The ONLY input is a full PressureReading carrying the pressure LEVEL and
    // the pageout DELTA. A caller cannot ask for a band from bare free RAM —
    // this is the "naive free RAM rejected by design" invariant, encoded as a
    // type-level fact (a reading is never just a free-RAM number).
    const probe: PressureProbe = { read: () => calm };
    const m = createPressureMonitor({ probe });
    const verdict = m.evaluate();
    // The verdict carries the whole reading (level + swap + pageout), not a
    // bare free-RAM figure.
    expect(verdict.reading).toMatchObject({ pressureLevel: 0, pageoutRate: 0 });
  });
});

describe('BE-9 pressure monitor — hysteresis + no-signal (edge/negative)', () => {
  it('does not flap amber↔normal at the amber line', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([
        { ...calm, freeRamPct: 24 }, // amber
        { ...calm, freeRamPct: 26 }, // just over the 25% line, within the 3-pt margin → HOLD amber
        { ...calm, freeRamPct: 40 }, // clears the margin → normal
      ]),
      hysteresisFreeRamPct: 3,
    });
    expect(m.evaluate().state).toBe('amber');
    expect(m.evaluate().state).toBe('amber');
    expect(m.evaluate().state).toBe('normal');
  });

  it('climbs down red → amber → normal stepwise (never red straight to normal on one clear)', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([
        { ...calm, pressureLevel: 4 }, // red
        { ...calm, pressureLevel: 2 }, // cleared red, still amber
        { ...calm, pressureLevel: 0 }, // fully clear → normal
      ]),
    });
    expect(m.evaluate().state).toBe('red');
    expect(m.evaluate().state).toBe('amber');
    expect(m.evaluate().state).toBe('normal');
  });

  it('a no-signal probe HOLDS the last state (never fabricates normal from nothing)', () => {
    const m = createPressureMonitor({
      probe: fakeProbe([{ ...calm, pressureLevel: 4 }, undefined]),
    });
    expect(m.evaluate().state).toBe('red');
    const held = m.evaluate();
    expect(held.state).toBe('red'); // held, not reset to normal
    expect(held.reading).toBeUndefined();
  });

  it('a throwing probe is swallowed (never takes the governor down)', () => {
    const m = createPressureMonitor({
      probe: {
        read: () => {
          throw new Error('probe blew up');
        },
      },
    });
    expect(() => m.evaluate()).not.toThrow();
    expect(m.evaluate().state).toBe('normal');
  });
});

describe('BE-9 real macOS probe — inert without a runner (never bloats/queries under test)', () => {
  it('createSpawnPressureProbe with no runner returns undefined (guarded runtime path)', () => {
    const probe = createSpawnPressureProbe();
    expect(probe.read()).toBeUndefined();
  });

  it('parses injected memory_pressure/vm_stat/sysctl output without shelling anything', () => {
    const outputs: Record<string, string> = {
      memory_pressure:
        'The system has 38654705664 (589824 pages with a page size of 65536).\n' +
        'System-wide memory free percentage: 42%\nCurrent pressure level: 2\n',
      vm_stat: 'Mach Virtual Memory Statistics:\nPageouts: 12345\n',
      sysctl: 'total = 4096.00M used = 21.50G free = 1024.00M\n',
    };
    const probe = createSpawnPressureProbe({
      run: (cmd) => outputs[cmd] ?? '',
    });
    const r = probe.read();
    expect(r?.freeRamPct).toBe(42);
    expect(r?.pressureLevel).toBe(2);
    expect(r?.swapUsedBytes).toBe(21.5 * GIB);
  });
});
