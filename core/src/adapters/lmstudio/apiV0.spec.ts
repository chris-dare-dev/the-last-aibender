import { startFakeLmStudioServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { createLmStudioApiV0Reader } from './apiV0.js';

describe('feature-gated /api/v0 state reads (blueprint §4.3 — beta surface)', () => {
  // -- negative: the gate is a value, not an exception -------------------------

  it('answers { enabled:false } when the feature gate is off', async () => {
    const reader = createLmStudioApiV0Reader({
      baseUrl: 'http://127.0.0.1:1',
      enabled: false,
    });
    expect(await reader.models()).toEqual({ enabled: false });
    expect(await reader.modelState('anything')).toEqual({ enabled: false });
  });

  // -- positive ---------------------------------------------------------------

  it('reads per-model residency state, quantization, and context length', async () => {
    const fake = await startFakeLmStudioServer();
    try {
      fake.addModel({
        key: 'synthetic-8b-q4',
        state: 'loaded',
        quantization: 'Q4_K_M',
        maxContextLength: 16384,
      });
      fake.addModel({ key: 'synthetic-12b-q4', state: 'not-loaded' });
      const reader = createLmStudioApiV0Reader({ baseUrl: fake.url, enabled: true });
      const result = await reader.models();
      expect(result.enabled).toBe(true);
      if (result.enabled !== true || !result.ok) return;
      expect(result.models).toEqual([
        {
          key: 'synthetic-8b-q4',
          state: 'loaded',
          quantization: 'Q4_K_M',
          maxContextLength: 16384,
          type: 'llm',
        },
        { key: 'synthetic-12b-q4', state: 'not-loaded', type: 'llm' },
      ]);

      const one = await reader.modelState('synthetic-12b-q4');
      if (one.enabled !== true || !one.ok) throw new Error('expected ok');
      expect(one.model?.state).toBe('not-loaded');
      const missing = await reader.modelState('never-installed');
      if (missing.enabled !== true || !missing.ok) throw new Error('expected ok');
      expect(missing.model).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  // -- edge: down stays first-class through the gate ----------------------------

  it('answers { ok:false, down } when the server is unreachable', async () => {
    const reader = createLmStudioApiV0Reader({
      baseUrl: 'http://127.0.0.1:9', // discard port — nothing listens
      enabled: true,
      timeoutMs: 200,
    });
    const result = await reader.models();
    expect(result.enabled).toBe(true);
    if (result.enabled !== true) return;
    expect(result.ok).toBe(false);
  });
});
