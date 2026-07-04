import { describe, expect, it } from 'vitest';

import { FakeQueryRunner } from './fakeQueryRunner.js';
import type { QuerySpec, RunnerMessage } from './queryRunner.js';

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    sessionId: 'ses_fake_1',
    prompt: 'synthesized prompt',
    cwd: '/synthetic/workspace',
    env: { AIBENDER_FAKE_KERNEL: '1' },
    abortController: new AbortController(),
    ...overrides,
  };
}

/** Consume a message stream to completion. Call WITHOUT awaiting to start a
 * concurrent consumer for manual-mode sessions, then await after driving. */
async function drain(messages: AsyncIterable<RunnerMessage>): Promise<RunnerMessage[]> {
  const received: RunnerMessage[] = [];
  for await (const message of messages) received.push(message);
  return received;
}

describe('FakeQueryRunner (canonical QueryRunner double; ICR-0001)', () => {
  // -- positive ---------------------------------------------------------------

  it('auto mode: emits init → success result → end, and records the full spec', async () => {
    const runner = new FakeQueryRunner();
    const s = spec();
    const handle = await runner.start(s);
    const messages = await drain(handle.messages());

    expect(runner.starts).toEqual([s]);
    expect(messages).toEqual([
      { type: 'init', nativeSessionId: 'fake-native-0' },
      { type: 'result', ok: true, detail: 'success' },
    ]);
  });

  it('fires onStart BEFORE the handle exists (row-before-spawn ordering hook)', async () => {
    const order: string[] = [];
    const runner = new FakeQueryRunner({
      onStart: () => {
        order.push('onStart');
      },
    });
    await runner.start(spec()).then(() => order.push('started'));
    expect(order).toEqual(['onStart', 'started']);
  });

  it('provides fake pids + spawn nonces when asked (backfillPid path)', async () => {
    const runner = new FakeQueryRunner({ providePids: true });
    const first = await runner.start(spec());
    const second = await runner.start(spec({ sessionId: 'ses_fake_2' }));
    expect(first.pid).toBe(40_000);
    expect(first.spawnNonce).toBe('fake-nonce-0');
    expect(second.pid).toBe(40_001);
  });

  it('manual mode: the session stays live until complete() and can fail', async () => {
    const runner = new FakeQueryRunner({ mode: 'manual' });
    const handle = await runner.start(spec());
    const collected = drain(handle.messages());

    const session = runner.session('ses_fake_1');
    session.emit({ type: 'other', raw: { synthesized: true } });
    session.complete({ ok: false, detail: 'error_during_execution' });

    expect(await collected).toEqual([
      { type: 'init', nativeSessionId: 'fake-native-0' },
      { type: 'other', raw: { synthesized: true } },
      { type: 'result', ok: false, detail: 'error_during_execution' },
    ]);
  });

  it('resume without fork keeps the native session id; fork mints a new one', async () => {
    const runner = new FakeQueryRunner();
    const resumed = await runner.start(
      spec({ resumeNativeSessionId: 'fake-native-77' }),
    );
    const forked = await runner.start(
      spec({ sessionId: 'ses_fake_2', resumeNativeSessionId: 'fake-native-77', forkSession: true }),
    );
    const resumedInit = (await drain(resumed.messages()))[0];
    const forkedInit = (await drain(forked.messages()))[0];
    expect(resumedInit).toEqual({ type: 'init', nativeSessionId: 'fake-native-77' });
    expect(forkedInit).toEqual({ type: 'init', nativeSessionId: 'fake-native-1' });
  });

  // -- negative ---------------------------------------------------------------

  it('failStart refuses the spawn: start rejects and nothing is recorded', async () => {
    const refusal = new Error('synthesized spawn refusal');
    const runner = new FakeQueryRunner({ failStart: () => refusal });
    await expect(runner.start(spec())).rejects.toBe(refusal);
    expect(runner.starts).toHaveLength(0);
    expect(() => runner.session('ses_fake_1')).toThrow(/no started session/);
  });

  it('session() throws for an unknown harness id', () => {
    expect(() => new FakeQueryRunner().session('ses_fake_404')).toThrow(
      /no started session ses_fake_404/,
    );
  });

  it('emit after the stream ended throws (push after end)', async () => {
    const runner = new FakeQueryRunner({ mode: 'manual' });
    await runner.start(spec());
    const session = runner.session('ses_fake_1');
    session.complete();
    expect(() => session.emit({ type: 'other', raw: null })).toThrow(/push after end/);
  });

  // -- edge -------------------------------------------------------------------

  it('aborting the spec controller ends the stream WITHOUT a result message', async () => {
    const runner = new FakeQueryRunner({ mode: 'manual' });
    const s = spec();
    const handle = await runner.start(s);
    const collected = drain(handle.messages());
    s.abortController.abort();
    expect(await collected).toEqual([{ type: 'init', nativeSessionId: 'fake-native-0' }]);
    // complete() after the abort is a silent no-op, not a crash.
    expect(() => runner.session('ses_fake_1').complete()).not.toThrow();
  });

  it('die() ends the stream without a result (process death shape)', async () => {
    const runner = new FakeQueryRunner({ mode: 'manual' });
    const handle = await runner.start(spec());
    const collected = drain(handle.messages());
    runner.session('ses_fake_1').die();
    expect(await collected).toEqual([{ type: 'init', nativeSessionId: 'fake-native-0' }]);
  });

  it('nativeIdFor overrides the default id scheme', async () => {
    const runner = new FakeQueryRunner({
      nativeIdFor: (s, index) => `synth-${s.sessionId}-${index}`,
    });
    const handle = await runner.start(spec());
    const init = (await drain(handle.messages()))[0];
    expect(init).toEqual({ type: 'init', nativeSessionId: 'synth-ses_fake_1-0' });
  });
});
