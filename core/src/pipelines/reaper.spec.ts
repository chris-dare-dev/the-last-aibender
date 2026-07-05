/**
 * Child-process-GROUP reaper (BE-8) — the DoD "budget breach aborts the step
 * with process-group reaping (no orphan children)". This suite spawns a REAL
 * detached process group (a parent `sh` that forks a long-lived child), then
 * proves reapStep SIGTERMs the WHOLE GROUP so the grandchild dies too (the
 * native #69856 failure mode: killing only the child orphans its workers).
 *
 * Rule 3 note: these are `sleep` processes, not model/inference calls — the
 * temporary-local-process exception. Every spawned pid is cleaned up.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProcessGroupReaper } from './reaper.js';

const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** True iff a process group is still alive (signal 0 probe). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ProcessGroupReaper — injected kill (unit)', () => {
  it('SIGTERMs a registered group, escalates to SIGKILL after the grace window', () => {
    vi.useFakeTimers();
    const signals: Array<{ pgid: number; signal: string }> = [];
    let alive = true;
    const reaper = createProcessGroupReaper({
      killGroup: (pgid, signal) => signals.push({ pgid, signal }),
      isGroupAlive: () => alive,
      graceMs: 1000,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    });
    reaper.register('step-1', 4242);
    expect(reaper.reapStep('step-1')).toBe(true);
    expect(signals).toEqual([{ pgid: 4242, signal: 'SIGTERM' }]);
    // The group survives the grace window → SIGKILL escalation.
    vi.advanceTimersByTime(1000);
    expect(signals).toContainEqual({ pgid: 4242, signal: 'SIGKILL' });
    // A group that died before the window is NOT SIGKILL'd.
    alive = false;
    signals.length = 0;
    reaper.register('step-2', 5252);
    reaper.reapStep('step-2');
    vi.advanceTimersByTime(1000);
    expect(signals).toEqual([{ pgid: 5252, signal: 'SIGTERM' }]);
    vi.useRealTimers();
  });

  it('reapStep is a no-op for an unknown key; clear() drops a registration', () => {
    const reaper = createProcessGroupReaper({ killGroup: () => {}, isGroupAlive: () => false });
    expect(reaper.reapStep('nope')).toBe(false);
    reaper.register('k', 1);
    reaper.clear('k');
    expect(reaper.reapStep('k')).toBe(false);
  });
});

describe('ProcessGroupReaper — REAL process group (integration)', () => {
  it('reaps a real detached group so the grandchild child dies too', async () => {
    // A parent sh that spawns a long sleep in the SAME group, then waits. The
    // child (sleep) is the "grandchild" relative to node — killing only the sh
    // would orphan the sleep; killing the GROUP takes both.
    const child = spawn('sh', ['-c', 'sleep 120 & sleep 120'], {
      detached: true, // new session/group → child.pid IS the pgid
      stdio: 'ignore',
    });
    spawned.push(child);
    const pgid = child.pid;
    expect(pgid).toBeGreaterThan(0);
    if (pgid === undefined) return;

    // Give the group a moment to establish its children.
    await new Promise((r) => setTimeout(r, 100));
    expect(groupAlive(pgid)).toBe(true);

    const reaper = createProcessGroupReaper({ graceMs: 300 });
    reaper.register('real-step', pgid);
    expect(reaper.reapStep('real-step')).toBe(true);

    // The whole GROUP dies (SIGTERM, then SIGKILL after grace) — no orphans.
    await waitUntil(() => !groupAlive(pgid), 3000);
    expect(groupAlive(pgid)).toBe(false);
  });
});
