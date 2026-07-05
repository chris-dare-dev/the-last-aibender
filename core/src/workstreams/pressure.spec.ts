/**
 * Context-pressure watch — the ~70% "branch now" advisory (blueprint §5;
 * frozen BranchAdvisory shape §16.1). Threshold configurable; hysteresis so
 * it fires ONCE per crossing.
 */

import { describe, expect, it } from 'vitest';

import { validateWorkstreamServerPayload, type WorkstreamServerPayload } from '@aibender/protocol';

import { createContextPressureWatch, extractUsageTokens } from './pressure.js';

function resultMessage(tokens: { input?: number; output?: number; cacheRead?: number }): unknown {
  return {
    type: 'result',
    usage: {
      input_tokens: tokens.input ?? 0,
      output_tokens: tokens.output ?? 0,
      cache_read_input_tokens: tokens.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
    },
  };
}

describe('extractUsageTokens', () => {
  it('reads snake_case result usage and nested assistant message.usage', () => {
    expect(extractUsageTokens(resultMessage({ input: 100, output: 50 }))).toMatchObject({
      input: 100,
      output: 50,
    });
    expect(
      extractUsageTokens({
        type: 'assistant',
        message: { usage: { inputTokens: 7, outputTokens: 3 } },
      }),
    ).toMatchObject({ input: 7, output: 3 });
  });

  it('junk / usage-free / all-zero messages carry no signal', () => {
    expect(extractUsageTokens(undefined)).toBeUndefined();
    expect(extractUsageTokens('text')).toBeUndefined();
    expect(extractUsageTokens({ type: 'system' })).toBeUndefined();
    expect(extractUsageTokens({ type: 'result', usage: {} })).toBeUndefined();
    expect(extractUsageTokens(resultMessage({}))).toBeUndefined();
  });
});

describe('createContextPressureWatch', () => {
  it('fires the frozen branch-advisory ONCE at the threshold crossing (hysteresis)', () => {
    const published: WorkstreamServerPayload[] = [];
    const watch = createContextPressureWatch({
      publish: (payload) => published.push(payload),
      thresholdPct: 70,
      contextWindowTokens: 1000,
      nowMs: () => 90_300_000,
    });

    watch.observe('ses_p', resultMessage({ input: 500 })); // 50% — below
    expect(published).toHaveLength(0);

    watch.observe('ses_p', resultMessage({ input: 720 })); // 72% — FIRES
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({
      kind: 'branch-advisory',
      sessionId: 'ses_p',
      contextUsedPct: 72,
      ts: 90_300_000,
    });
    expect(validateWorkstreamServerPayload(published[0]).ok).toBe(true);

    watch.observe('ses_p', resultMessage({ input: 800 })); // 80% — hovers, NO re-fire
    watch.observe('ses_p', resultMessage({ input: 990 })); // 99% — still no re-fire
    expect(published).toHaveLength(1);
    expect(watch.stats().advisoriesFired).toBe(1);
  });

  it('re-arms only after pressure falls below the rearm level, then fires again', () => {
    const published: WorkstreamServerPayload[] = [];
    const watch = createContextPressureWatch({
      publish: (payload) => published.push(payload),
      thresholdPct: 70,
      rearmBelowPct: 40,
      contextWindowTokens: 1000,
    });
    watch.observe('ses_p', resultMessage({ input: 750 })); // fires
    watch.observe('ses_p', resultMessage({ input: 500 })); // 50% — NOT below rearm
    watch.observe('ses_p', resultMessage({ input: 760 })); // still disarmed
    expect(published).toHaveLength(1);

    watch.observe('ses_p', resultMessage({ input: 300 })); // 30% — re-armed (compaction/fork)
    watch.observe('ses_p', resultMessage({ input: 710 })); // fires again
    expect(published).toHaveLength(2);
  });

  it('threshold is configurable; pct clamps to 100; sessions are independent', () => {
    const published: WorkstreamServerPayload[] = [];
    const watch = createContextPressureWatch({
      publish: (payload) => published.push(payload),
      thresholdPct: 90,
      contextWindowTokens: 100,
    });
    watch.observe('ses_a', resultMessage({ input: 80 })); // 80% < 90 — silent
    expect(published).toHaveLength(0);
    watch.observe('ses_a', resultMessage({ input: 250 })); // >100 → clamped 100, fires
    expect(published).toHaveLength(1);
    expect((published[0] as { contextUsedPct: number }).contextUsedPct).toBe(100);

    watch.observe('ses_b', resultMessage({ input: 95 })); // independent session fires
    expect(published).toHaveLength(2);
    expect(watch.pressureOf('ses_a')).toBe(100);
    expect(watch.pressureOf('ses_b')).toBe(95);
  });

  it('observe NEVER throws — junk input and a refusing publisher are both swallowed', () => {
    const watch = createContextPressureWatch({
      publish: () => {
        throw new RangeError('synthetic publisher refusal');
      },
      thresholdPct: 10,
      contextWindowTokens: 10,
    });
    expect(() => watch.observe('ses_x', null)).not.toThrow();
    expect(() => watch.observe('ses_x', resultMessage({ input: 100 }))).not.toThrow();
    expect(watch.stats().advisoriesFired).toBe(1); // fired; the refusal was logged
  });

  it('refuses nonsensical configuration', () => {
    expect(() => createContextPressureWatch({ thresholdPct: 0 })).toThrowError(RangeError);
    expect(() => createContextPressureWatch({ thresholdPct: 101 })).toThrowError(RangeError);
    expect(() =>
      createContextPressureWatch({ thresholdPct: 50, rearmBelowPct: 60 }),
    ).toThrowError(RangeError);
    expect(() => createContextPressureWatch({ contextWindowTokens: 0 })).toThrowError(RangeError);
  });

  it('forget() drops per-session state', () => {
    const watch = createContextPressureWatch({ contextWindowTokens: 1000 });
    watch.observe('ses_gone', resultMessage({ input: 100 }));
    expect(watch.pressureOf('ses_gone')).toBe(10);
    watch.forget('ses_gone');
    expect(watch.pressureOf('ses_gone')).toBeUndefined();
  });
});
