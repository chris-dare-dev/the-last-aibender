import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSdkQueryRunner,
  resolveBundledClaudeExecutable,
  type QueryFn,
  type SdkQueryLike,
} from './sdkQueryRunner.js';
import { LiveSpawnDisabledError, TokenMixingError } from './errors.js';
import type { QuerySpec, RunnerMessage } from './queryRunner.js';

// ---------------------------------------------------------------------------
// Helpers — a fake SDK query() that records params and yields SDK-shaped
// messages WITHOUT spawning anything.
// ---------------------------------------------------------------------------

function fakeQueryFn(
  messages: readonly unknown[],
): { fn: QueryFn; calls: { prompt: string; options?: Record<string, unknown> }[] } {
  const calls: { prompt: string; options?: Record<string, unknown> }[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params);
    const iterable: SdkQueryLike = {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      interrupt: async () => {},
    };
    return iterable;
  };
  return { fn, calls };
}

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    sessionId: 'ses_synthetic',
    prompt: 'synthesized prompt',
    cwd: '/synthetic/workspace',
    env: Object.freeze({ CLAUDE_CONFIG_DIR: '/synthetic/max-a', PATH: '/usr/bin' }),
    abortController: new AbortController(),
    ...overrides,
  };
}

const EXEC_OVERRIDE = '/synthetic/pinned/claude';

describe('SdkQueryRunner — the real spawn path (BE-1)', () => {
  // -- positive ---------------------------------------------------------------

  it('resolves the SDK-bundled binary for this platform (pinned, existing, absolute)', () => {
    const executable = resolveBundledClaudeExecutable();
    expect(isAbsolute(executable)).toBe(true);
    expect(executable.endsWith('/claude')).toBe(true);
    expect(executable).toContain(
      `claude-agent-sdk-${process.platform}-${process.arch}`,
    );
    expect(existsSync(executable)).toBe(true);
  });

  it('passes the built env as the COMPLETE subprocess env and pins the executable', async () => {
    const { fn, calls } = fakeQueryFn([]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    const s = spec();
    const handle = await runner.start(s);
    for await (const _ of handle.messages()) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const options = calls[0]?.options ?? {};
    expect(options['env']).toEqual({ ...s.env }); // full replacement, nothing merged
    expect(options['pathToClaudeCodeExecutable']).toBe(EXEC_OVERRIDE);
    expect(options['cwd']).toBe(s.cwd);
    expect(options['abortController']).toBe(s.abortController);
    expect(options).not.toHaveProperty('resume');
    expect(options).not.toHaveProperty('forkSession');
  });

  it('maps SDK messages to the narrow runner union (init / result / other)', async () => {
    const { fn } = fakeQueryFn([
      { type: 'system', subtype: 'init', session_id: 'native-uuid-synth', model: 'synth' },
      { type: 'assistant', message: { content: [] } },
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    const handle = await runner.start(spec());
    const received: RunnerMessage[] = [];
    for await (const message of handle.messages()) received.push(message);

    expect(received[0]).toEqual({ type: 'init', nativeSessionId: 'native-uuid-synth' });
    expect(received[1]?.type).toBe('other');
    expect(received[2]).toEqual({ type: 'result', ok: true, detail: 'success' });
  });

  it('propagates resume / forkSession / resumeSessionAt for the repair-fork path', async () => {
    const { fn, calls } = fakeQueryFn([]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    const handle = await runner.start(
      spec({
        resumeNativeSessionId: 'native-parent',
        forkSession: true,
        resumeSessionAt: 'synthmsg-7',
      }),
    );
    for await (const _ of handle.messages()) {
      // drain
    }
    const options = calls[0]?.options ?? {};
    expect(options['resume']).toBe('native-parent');
    expect(options['forkSession']).toBe(true);
    expect(options['resumeSessionAt']).toBe('synthmsg-7');
  });

  // -- negative ---------------------------------------------------------------

  it('REFUSES construction without the explicit live-spawn opt-in', () => {
    expect(() =>
      createSdkQueryRunner({ liveSpawnOptIn: false, pathToClaudeCodeExecutable: EXEC_OVERRIDE }),
    ).toThrow(LiveSpawnDisabledError);
  });

  it('refuses an env carrying CLAUDE_CODE_OAUTH_TOKEN (defense in depth)', async () => {
    const { fn } = fakeQueryFn([]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    await expect(
      runner.start(
        spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'obviously-fake-not-a-real-token' } }),
      ),
    ).rejects.toBeInstanceOf(TokenMixingError);
  });

  it('refuses --bare and any extraArgs at M1', async () => {
    const { fn } = fakeQueryFn([]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    await expect(runner.start(spec({ extraArgs: ['--bare'] }))).rejects.toMatchObject({
      name: 'BareModeRefusedError',
    });
    await expect(runner.start(spec({ extraArgs: ['--verbose'] }))).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  // -- edge -------------------------------------------------------------------

  it('error-subtype results map to ok:false with the subtype as detail', async () => {
    const { fn } = fakeQueryFn([
      { type: 'result', subtype: 'error_during_execution', is_error: true },
    ]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    const handle = await runner.start(spec());
    const received: RunnerMessage[] = [];
    for await (const message of handle.messages()) received.push(message);
    expect(received[0]).toEqual({
      type: 'result',
      ok: false,
      detail: 'error_during_execution',
    });
  });

  it('non-object and unknown-shape stream items degrade to `other`, never throw', async () => {
    const { fn } = fakeQueryFn(['strange', null, { type: 'system', subtype: 'compact' }]);
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: EXEC_OVERRIDE,
      queryFn: fn,
    });
    const handle = await runner.start(spec());
    const received: RunnerMessage[] = [];
    for await (const message of handle.messages()) received.push(message);
    expect(received.map((m) => m.type)).toEqual(['other', 'other', 'other']);
  });
});
