import { describe, expect, it, vi } from 'vitest';

import type { ErrorCode, LaunchParams } from '@aibender/protocol';

import {
  FakeKernel,
  FakeKernelVerbError,
  isKernelVerbErrorLike,
} from './fakeKernel.js';
import { FakeQueryRunner } from './fakeQueryRunner.js';

function launchParams(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate: 'sdk',
    cwd: '/synthetic/workspace',
    purpose: 'synthesized gateway test session',
    ...overrides,
  };
}

async function code(promise: Promise<unknown>): Promise<ErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (isKernelVerbErrorLike(error)) return error.code;
    throw error;
  }
  throw new Error('expected the verb to reject');
}

describe('FakeKernel (gateway kernel-port double over FakeQueryRunner; ICR-0002)', () => {
  // -- positive ---------------------------------------------------------------

  it('launch answers spawning immediately, with the row already queryable', async () => {
    const kernel = new FakeKernel();
    const launched = await kernel.launch(launchParams());
    expect(launched).toEqual({ sessionId: 'ses_fake_1', state: 'spawning' });
    // Row-before-spawn: status sees the session even before the spawn settles.
    const statuses = await kernel.status(launched.sessionId);
    expect(statuses[0]?.state).toBe('spawning');
  });

  it('the async spawn brings running + pid, and init backfills nativeSessionId', async () => {
    const kernel = new FakeKernel();
    const { sessionId } = await kernel.launch(launchParams());
    await kernel.spawnSettled(sessionId);
    expect(kernel.stateOf(sessionId)).toBe('running');
    await vi.waitFor(async () => {
      const [status] = await kernel.status(sessionId);
      expect(status?.pid).toBe(40_000);
      expect(status?.nativeSessionId).toBe('fake-native-0');
    });
    // The runner recorded the spawn spec (env-snapshot assertions ride here).
    expect(kernel.runner.starts[0]?.sessionId).toBe(sessionId);
    expect(kernel.runner.starts[0]?.env['AIBENDER_FAKE_ACCOUNT']).toBe('MAX_A');
  });

  it('in-place resume of an exited session reuses the native id', async () => {
    const kernel = new FakeKernel();
    const { sessionId } = await kernel.launch(launchParams());
    await kernel.spawnSettled(sessionId);
    kernel.runner.session(sessionId).complete();
    await vi.waitFor(() => expect(kernel.stateOf(sessionId)).toBe('exited'));

    const resumed = await kernel.resume({ sessionId, fork: false });
    expect(resumed).toEqual({ sessionId, state: 'resumed' });
    await kernel.spawnSettled(sessionId);
    expect(kernel.runner.starts[1]?.resumeNativeSessionId).toBe('fake-native-0');
    expect(kernel.runner.starts[1]?.forkSession).toBeUndefined();
    expect(kernel.stateOf(sessionId)).toBe('resumed');
  });

  it('fork resumes as a continuation CHILD carrying forkedFrom (X4 edge)', async () => {
    const kernel = new FakeKernel();
    const { sessionId } = await kernel.launch(launchParams());
    await kernel.spawnSettled(sessionId);

    const forked = await kernel.resume({ sessionId, fork: true });
    expect(forked.sessionId).not.toBe(sessionId);
    expect(forked.state).toBe('resumed');
    expect(forked.forkedFrom).toBe(sessionId);
    await kernel.spawnSettled(forked.sessionId);
    const forkSpec = kernel.runner.starts.at(-1);
    expect(forkSpec?.forkSession).toBe(true);
    // Parent stays live and untouched.
    expect(kernel.stateOf(sessionId)).toBe('running');
  });

  it('kill settles the session to exited and records the mode', async () => {
    const kernel = new FakeKernel();
    const { sessionId } = await kernel.launch(launchParams());
    const killed = await kernel.kill({ sessionId, mode: 'graceful' });
    expect(killed).toEqual({ sessionId, state: 'exited' });
    expect(kernel.kills).toEqual([{ sessionId, mode: 'graceful' }]);
    const [status] = await kernel.status(sessionId);
    expect(status?.pid).toBeUndefined();
  });

  it('status without an id reports every ledger session', async () => {
    const kernel = new FakeKernel();
    await kernel.launch(launchParams());
    await kernel.launch(launchParams({ accountLabel: 'MAX_B' }));
    const statuses = await kernel.status();
    expect(statuses.map((s) => s.sessionId)).toEqual(['ses_fake_1', 'ses_fake_2']);
  });

  // -- negative ---------------------------------------------------------------

  it('unknown session ids answer session-not-found on every verb that takes one', async () => {
    const kernel = new FakeKernel();
    expect(await code(kernel.resume({ sessionId: 'ses_fake_404', fork: false }))).toBe(
      'session-not-found',
    );
    expect(await code(kernel.kill({ sessionId: 'ses_fake_404', mode: 'force' }))).toBe(
      'session-not-found',
    );
    expect(await code(kernel.status('ses_fake_404'))).toBe('session-not-found');
  });

  it('un-forked resume of a running-family session is double-resume-blocked', async () => {
    const kernel = new FakeKernel();
    const { sessionId } = await kernel.launch(launchParams());
    await kernel.spawnSettled(sessionId);
    expect(kernel.stateOf(sessionId)).toBe('running');
    expect(await code(kernel.resume({ sessionId, fork: false }))).toBe(
      'double-resume-blocked',
    );
    // ...and while still spawning, too (spawning is running-family).
    const second = await kernel.launch(launchParams());
    expect(await code(kernel.resume({ sessionId: second.sessionId, fork: false }))).toBe(
      'double-resume-blocked',
    );
  });

  it('rejections carry the KernelVerbError shape; a custom factory is honored', async () => {
    const plain = new FakeKernel();
    const error = await plain.status('ses_fake_404').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(FakeKernelVerbError);
    expect(isKernelVerbErrorLike(error)).toBe(true);

    class InjectedError extends Error {
      constructor(readonly codeValue: string) {
        super('injected');
      }
    }
    const injected = new FakeKernel(undefined, {
      verbError: (codeValue, message) => new InjectedError(`${codeValue}:${message.length}`),
    });
    await expect(injected.status('ses_fake_404')).rejects.toBeInstanceOf(InjectedError);
  });

  it('FakeKernelVerbError refuses unregistered codes; the structural guard is strict', () => {
    expect(() => new FakeKernelVerbError('quota-exceeded' as ErrorCode, 'nope')).toThrow(
      RangeError,
    );
    expect(isKernelVerbErrorLike(new Error('plain'))).toBe(false);
    // A hand-rolled error with the right shape matches (core's class does too).
    const shaped = Object.assign(new Error('shaped'), {
      name: 'KernelVerbError',
      code: 'internal',
      retryable: false,
    });
    expect(isKernelVerbErrorLike(shaped)).toBe(true);
  });

  // -- edge -------------------------------------------------------------------

  it('autoSpawn:false holds the launch in spawning until released', async () => {
    const kernel = new FakeKernel(undefined, { autoSpawn: false });
    const { sessionId } = await kernel.launch(launchParams());
    expect(kernel.stateOf(sessionId)).toBe('spawning');
    expect(kernel.pendingSpawnCount()).toBe(1);

    kernel.releaseSpawn(sessionId);
    await kernel.spawnSettled(sessionId);
    expect(kernel.stateOf(sessionId)).toBe('running');
    expect(kernel.pendingSpawnCount()).toBe(0);
    // Kill-while-launching, resolved after the spawn settled (SPIKE-D order).
    const killed = await kernel.kill({ sessionId, mode: 'force' });
    expect(killed.state).toBe('exited');
  });

  it('failSpawn settles the gated session to exited (spawn-failure path)', async () => {
    const kernel = new FakeKernel(undefined, { autoSpawn: false });
    const { sessionId } = await kernel.launch(launchParams());
    kernel.failSpawn(sessionId);
    await kernel.spawnSettled(sessionId);
    expect(kernel.stateOf(sessionId)).toBe('exited');
    expect(kernel.runner.starts).toHaveLength(0); // the spawn never happened
    expect(() => kernel.releaseSpawn(sessionId)).toThrow(/no pending spawn/);
  });

  it('a runner-side completion settles the session to exited (result pump)', async () => {
    const kernel = new FakeKernel();
    const { sessionId } = await kernel.launch(launchParams());
    await kernel.spawnSettled(sessionId);
    kernel.runner.session(sessionId).complete({ ok: false });
    await vi.waitFor(() => expect(kernel.stateOf(sessionId)).toBe('exited'));
    // Killing an already-exited session is idempotent and records nothing.
    const killed = await kernel.kill({ sessionId, mode: 'graceful' });
    expect(killed.state).toBe('exited');
    expect(kernel.kills).toHaveLength(0);
  });

  it('an auto-mode runner is allowed: sessions launch and complete instantly', async () => {
    const kernel = new FakeKernel(new FakeQueryRunner({ mode: 'auto' }));
    const { sessionId } = await kernel.launch(launchParams());
    await kernel.spawnSettled(sessionId);
    await vi.waitFor(() => expect(kernel.stateOf(sessionId)).toBe('exited'));
  });
});
