import { startFakeLmStudioServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { LiveLmsCliDisabledError } from '../errors.js';
import { createLmStudioApiV0Reader } from './apiV0.js';
import { createLmsCliLifecycle, verifyUnload, type LmsExecFn } from './lifecycle.js';

describe('lms CLI lifecycle behind an interface (BE-4; blueprint §4.3)', () => {
  // -- negative: the live gate -------------------------------------------------

  it('REFUSES construction without the explicit live opt-in', () => {
    expect(() => createLmsCliLifecycle({ liveCliOptIn: false as unknown as true })).toThrow(
      LiveLmsCliDisabledError,
    );
  });

  // -- positive: verb → argv mapping (no shelling in tests) ---------------------

  it('maps every verb to the documented lms argv', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFn: LmsExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'synthetic-ok', stderr: '', code: 0 };
    };
    const lifecycle = createLmsCliLifecycle({ liveCliOptIn: true, execFn });

    await lifecycle.serverStart();
    await lifecycle.serverStop();
    await lifecycle.load('synthetic-8b-q4', { ttlSeconds: 1800 });
    await lifecycle.unload('synthetic-8b-q4');
    await lifecycle.ps();

    expect(calls.map((call) => call.args)).toEqual([
      ['server', 'start'],
      ['server', 'stop'],
      ['load', 'synthetic-8b-q4', '--ttl', '1800', '--yes'],
      ['unload', 'synthetic-8b-q4'],
      ['ps', '--json'],
    ]);
    expect(new Set(calls.map((call) => call.file))).toEqual(new Set(['lms']));
  });

  it('reports ok:false on a non-zero exit without throwing', async () => {
    const execFn: LmsExecFn = async () => ({ stdout: '', stderr: 'synthetic fail', code: 1 });
    const lifecycle = createLmsCliLifecycle({ liveCliOptIn: true, execFn });
    const result = await lifecycle.serverStart();
    expect(result).toEqual({ ok: false, output: 'synthetic fail' });
  });
});

describe('verified unload (known auto-evict-bypass bugs — never assume)', () => {
  // -- positive: LM Studio JIT load + TTL evict verified via API (plan §9.2) ----

  it('verifies once the API reports not-loaded', async () => {
    const fake = await startFakeLmStudioServer();
    try {
      fake.addModel({ key: 'synthetic-8b-q4', state: 'loaded' });
      const reader = createLmStudioApiV0Reader({ baseUrl: fake.url, enabled: true });
      // Simulate the evict landing between polls.
      setTimeout(() => fake.setModelState('synthetic-8b-q4', 'not-loaded'), 20);
      const verification = await verifyUnload('synthetic-8b-q4', reader, {
        attempts: 10,
        intervalMs: 10,
      });
      expect(verification.verified).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('a model UNKNOWN to the server counts as unloaded', async () => {
    const fake = await startFakeLmStudioServer();
    try {
      const reader = createLmStudioApiV0Reader({ baseUrl: fake.url, enabled: true });
      const verification = await verifyUnload('never-loaded', reader, { attempts: 1 });
      expect(verification.verified).toBe(true);
    } finally {
      await fake.close();
    }
  });

  // -- negative: the bug shape the verifier exists for --------------------------

  it('reports still-loaded when the unload was silently bypassed (#2051)', async () => {
    const fake = await startFakeLmStudioServer();
    try {
      fake.addModel({ key: 'synthetic-8b-q4', state: 'loaded' }); // never unloads
      const reader = createLmStudioApiV0Reader({ baseUrl: fake.url, enabled: true });
      const verification = await verifyUnload('synthetic-8b-q4', reader, {
        attempts: 3,
        intervalMs: 1,
      });
      expect(verification).toEqual({ verified: false, reason: 'still-loaded', attempts: 3 });
    } finally {
      await fake.close();
    }
  });

  // -- edge: honesty when verification is impossible -----------------------------

  it('reports api-v0-gated instead of assuming success', async () => {
    const reader = createLmStudioApiV0Reader({ baseUrl: 'http://127.0.0.1:1', enabled: false });
    const verification = await verifyUnload('synthetic-8b-q4', reader);
    expect(verification).toEqual({ verified: false, reason: 'api-v0-gated', attempts: 1 });
  });

  it('reports down when the server cannot be asked', async () => {
    const reader = createLmStudioApiV0Reader({
      baseUrl: 'http://127.0.0.1:9',
      enabled: true,
      timeoutMs: 100,
    });
    const verification = await verifyUnload('synthetic-8b-q4', reader, { attempts: 2 });
    expect(verification).toEqual({ verified: false, reason: 'down', attempts: 1 });
  });
});
