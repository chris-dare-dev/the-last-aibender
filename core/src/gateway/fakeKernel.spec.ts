/**
 * Direct pins on the FakeKernel/FakeQueryRunner test double so the server
 * suite's assumptions about its discipline (row-before-spawn, double-resume
 * block, fork = child, gated starts) are themselves tested.
 */

import { describe, expect, it } from 'vitest';

import type { LaunchParams } from '@aibender/protocol';

import { FakeKernel, FakeQueryRunner } from './fakeKernel.js';
import { KernelVerbError } from './kernel.js';

const params: LaunchParams = {
  accountLabel: 'MAX_B',
  backend: 'claude_code',
  substrate: 'sdk',
  cwd: '/synthesized/workspace',
  purpose: 'fake kernel pin',
};

describe('FakeKernel (test double discipline)', () => {
  it('launch answers spawning, transitions to running with a fake pid (positive)', async () => {
    const kernel = new FakeKernel(new FakeQueryRunner());
    const launched = await kernel.launch(params);
    expect(launched.state).toBe('spawning');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [status] = await kernel.status(launched.sessionId);
    expect(status?.state).toBe('running');
    expect(status?.pid).toBeGreaterThan(0);
  });

  it('rejects unknown sessions with session-not-found (negative)', async () => {
    const kernel = new FakeKernel(new FakeQueryRunner());
    for (const call of [
      kernel.resume({ sessionId: 'ses_missing', fork: false }),
      kernel.kill({ sessionId: 'ses_missing', mode: 'graceful' }),
      kernel.status('ses_missing'),
    ]) {
      await expect(call).rejects.toMatchObject(
        new KernelVerbError('session-not-found', 'no ledger row for the requested session'),
      );
    }
  });

  it('blocks un-forked double-resume of a running-family session (negative)', async () => {
    const kernel = new FakeKernel(new FakeQueryRunner());
    const launched = await kernel.launch(params);
    await expect(
      kernel.resume({ sessionId: launched.sessionId, fork: false }),
    ).rejects.toMatchObject({ code: 'double-resume-blocked' });
  });

  it('a failed gated start exits the session; kill stays idempotent (edge)', async () => {
    const runner = new FakeQueryRunner({ autoStart: false });
    const kernel = new FakeKernel(runner);
    const launched = await kernel.launch(params);
    runner.failStart(launched.sessionId);
    // kill waits for the settled spawn, sees `exited`, and does not double-stop.
    const killed = await kernel.kill({ sessionId: launched.sessionId, mode: 'force' });
    expect(killed.state).toBe('exited');
    expect(runner.stoppedSessionIds).toHaveLength(0);
    const again = await kernel.kill({ sessionId: launched.sessionId, mode: 'force' });
    expect(again.state).toBe('exited');
  });
});
