/**
 * Pure selector + formatting edges (plan §9.2 FE-5):
 * Positive: countdown/usd/token formats are grid-stable; VM ordering follows
 *           the frozen label order.
 * Negative: a basis-tampered api-equivalent snapshot renders nothing.
 * Edge:     reset instants in the past read DUE; sub-minute countdowns never
 *           read 0M; live-vs-read-model merge picks the newer capture.
 */

import { describe, expect, it } from 'vitest';
import type { ApiEquivalentUsdSnapshot, BurnRateSnapshot } from '@aibender/protocol';
import { fmtCountdown, fmtMs, fmtTokens, fmtTokensPerHour, fmtUsd } from './format.ts';
import { apiEquivalentVM, burnRateVM, quotaGaugesVM } from './instruments.ts';
import { quotaGaugesSnap, src, T0 } from './specHelpers.ts';

describe('format', () => {
  it('countdowns are compact and never read 0M in the future (edge)', () => {
    expect(fmtCountdown(T0, T0 - 1)).toBe('DUE');
    expect(fmtCountdown(T0, T0)).toBe('DUE');
    expect(fmtCountdown(T0, T0 + 5_000)).toBe('1M');
    expect(fmtCountdown(T0, T0 + 83 * 60_000)).toBe('1H23M');
    expect(fmtCountdown(T0, T0 + 26 * 3_600_000)).toBe('1D02H');
  });

  it('numbers hold grid-stable shapes', () => {
    expect(fmtUsd(12.5)).toBe('$12.50');
    expect(fmtTokens(900)).toBe('900');
    expect(fmtTokens(120_000)).toBe('120.0K');
    expect(fmtTokens(3_400_000)).toBe('3.4M');
    expect(fmtTokensPerHour(120_000)).toBe('120.0K/H');
    expect(fmtMs(300)).toBe('300MS');
    expect(fmtMs(12_500)).toBe('12.5S');
  });
});

describe('instrument view models', () => {
  it('a basis-tampered api-equivalent snapshot renders nothing (negative)', () => {
    const tampered = {
      kind: 'read-model-snapshot',
      readModel: 'api-equivalent-usd',
      capturedAt: T0,
      sources: [src('fresh')],
      data: {
        basis: 'spend', // adversarial: not the frozen literal
        entries: [{ account: 'ENT', backend: 'claude_code', equivalentUsd: 42 }],
        windowDays: 7,
      },
    } as unknown as ApiEquivalentUsdSnapshot;
    const vm = apiEquivalentVM(tampered);
    expect(vm.rows).toHaveLength(0);
    expect(vm.health.readout).toBe('NO SIGNAL');
  });

  it('burn-rate rows follow the frozen label order; exhaustion degrades (positive)', () => {
    const snapshot: BurnRateSnapshot = {
      kind: 'read-model-snapshot',
      readModel: 'burn-rate',
      capturedAt: T0,
      sources: [src('fresh', 'claude-jsonl', T0 - 1000)],
      data: {
        entries: [
          {
            account: 'ENT',
            blockStartAt: T0,
            blockEndAt: T0 + 1,
            tokensPerHour: 1,
            projectedExhaustionAt: T0 + 2,
          },
          { account: 'MAX_A', blockStartAt: T0, blockEndAt: T0 + 1, tokensPerHour: 2 },
        ],
      },
    };
    const vm = burnRateVM(snapshot);
    expect(vm.rows.map((r) => r.account)).toEqual(['MAX_A', 'ENT']);
    expect(vm.health.readout).toBe('DEGRADED');
  });

  it('the gauge merge picks the newer capture per slot (edge)', () => {
    const rm = quotaGaugesSnap(
      [src('fresh', 'claude-quota', T0 - 1000)],
      [
        { account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: T0 + 100_000 },
        { account: 'MAX_B', window: '5h', usedPct: 10, resetsAt: T0 + 100_000 },
      ],
      T0,
    );
    const vm = quotaGaugesVM(rm, {
      'MAX_A/5h': {
        kind: 'quota-snapshot',
        account: 'MAX_A',
        window: '5h',
        usedPct: 60,
        resetsAt: T0 + 90_000,
        capturedAt: T0 + 1_000, // newer → wins
        source: 'statusline',
      },
      'MAX_B/5h': {
        kind: 'quota-snapshot',
        account: 'MAX_B',
        window: '5h',
        usedPct: 99,
        resetsAt: T0 + 90_000,
        capturedAt: T0 - 5_000, // older → never regresses the read model
        source: 'statusline',
      },
    });
    const maxA = vm.rows.find((r) => r.account === 'MAX_A' && r.window === '5h');
    const maxB = vm.rows.find((r) => r.account === 'MAX_B' && r.window === '5h');
    expect(maxA?.usedPct).toBe(60);
    expect(maxB?.usedPct).toBe(10);
    // The fixed six slots always render, silent ones as undefined.
    expect(vm.rows).toHaveLength(6);
    expect(vm.rows.filter((r) => r.usedPct === undefined)).toHaveLength(4);
  });
});
