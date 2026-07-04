/**
 * defaultPidLivenessProbe — real-process-table tests (plan §9.2 BE-1 rows).
 * Probes REAL, test-owned child processes: a controlled `node -e` holder that
 * carries a synthesized argv nonce. No real session binaries involved [X2].
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultPidLivenessProbe } from './pidLiveness.js';

const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

/** Spawn a long-lived holder process whose argv carries the nonce. */
async function spawnHolder(nonce: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', nonce], {
    stdio: 'ignore',
  });
  children.push(child);
  await once(child, 'spawn');
  return child;
}

describe('defaultPidLivenessProbe', () => {
  // -- positive ---------------------------------------------------------------

  it('alive child with the recorded argv nonce → alive (same process)', async () => {
    const nonce = `aibender-synth-nonce-${process.pid}-${Date.now()}`;
    const child = await spawnHolder(nonce);
    expect(child.pid).toBeDefined();
    expect(defaultPidLivenessProbe.isSameProcessAlive(child.pid as number, nonce)).toBe(true);
    child.kill('SIGKILL');
    await once(child, 'exit');
  });

  it('alive pid with NO recorded nonce → alive (conservative: refusal beats corruption)', () => {
    expect(defaultPidLivenessProbe.isSameProcessAlive(process.pid, null)).toBe(true);
  });

  // -- negative ---------------------------------------------------------------

  it('SIGKILLed child → dead', async () => {
    const nonce = `aibender-synth-nonce-dead-${process.pid}-${Date.now()}`;
    const child = await spawnHolder(nonce);
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(defaultPidLivenessProbe.isSameProcessAlive(child.pid as number, nonce)).toBe(false);
  });

  it('alive pid whose argv lacks the nonce → dead (pid-reuse guard, SPIKE-D)', async () => {
    const nonce = `aibender-synth-nonce-real-${process.pid}-${Date.now()}`;
    const child = await spawnHolder(nonce);
    expect(
      defaultPidLivenessProbe.isSameProcessAlive(child.pid as number, 'synth-nonce-of-a-stranger'),
    ).toBe(false);
    child.kill('SIGKILL');
    await once(child, 'exit');
  });

  // -- edge ---------------------------------------------------------------------

  it('non-positive and absurd pids are dead, never signalled (kill(-1) hazard guard)', () => {
    expect(defaultPidLivenessProbe.isSameProcessAlive(-1, null)).toBe(false);
    expect(defaultPidLivenessProbe.isSameProcessAlive(0, null)).toBe(false);
    expect(defaultPidLivenessProbe.isSameProcessAlive(99_999_999, null)).toBe(false);
    expect(defaultPidLivenessProbe.isSameProcessAlive(Number.NaN, null)).toBe(false);
  });
});
