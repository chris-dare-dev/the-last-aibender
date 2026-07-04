import { describe, expect, it } from 'vitest';

import {
  createSdkQueryRunner as kernelCreateSdkQueryRunner,
} from '../../kernel/sdkQueryRunner.js';
import { LiveSpawnDisabledError } from '../../kernel/errors.js';
import { createClaudeSdkAdapter, createSdkQueryRunner } from './index.js';

describe('claude-sdk adapter — THIN wrapper over the M1 kernel seam (BE-4)', () => {
  // -- positive: adapter symmetry without a second implementation --------------

  it('createClaudeSdkAdapter IS the kernel factory (identical reference)', () => {
    expect(createClaudeSdkAdapter).toBe(kernelCreateSdkQueryRunner);
    expect(createSdkQueryRunner).toBe(kernelCreateSdkQueryRunner);
  });

  // -- negative: the kernel's live gate applies unchanged -----------------------

  it('refuses construction without the explicit live-spawn opt-in', () => {
    expect(() => createClaudeSdkAdapter({ liveSpawnOptIn: false as unknown as true })).toThrow(
      LiveSpawnDisabledError,
    );
  });

  // -- edge: with the opt-in and an injected queryFn, the seam behaves as M1 ----

  it('constructs with opt-in + injected queryFn (no real spawn)', async () => {
    const runner = createClaudeSdkAdapter({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: '/synthetic/claude',
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'synth-native-1' };
          yield { type: 'result', subtype: 'success' };
        },
        interrupt: async () => undefined,
      }),
    });
    const handle = await runner.start({
      sessionId: 'sess-synth-1',
      prompt: 'synthesized prompt',
      cwd: '/synthetic/cwd',
      env: {},
      abortController: new AbortController(),
    });
    const messages = [];
    for await (const message of handle.messages()) messages.push(message);
    // ICR-0009: init/result retain the verbatim SDK message for the tee.
    expect(messages).toEqual([
      {
        type: 'init',
        nativeSessionId: 'synth-native-1',
        raw: { type: 'system', subtype: 'init', session_id: 'synth-native-1' },
      },
      {
        type: 'result',
        ok: true,
        detail: 'success',
        raw: { type: 'result', subtype: 'success' },
      },
    ]);
  });
});
