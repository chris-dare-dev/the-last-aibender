/**
 * FakePtyBackend double sanity suite (ICR-0006) — the fake must honor the
 * PtyBackend seam contract its real node-pty counterpart commits to, or
 * every pty suite built on it proves nothing.
 *
 * [X2]: every byte here is synthesized.
 */

import { describe, expect, it } from 'vitest';

import {
  FAKE_PTY_EXECUTABLE,
  FakePtyBackend,
  FakePtyProcess,
  SYNTHETIC_LOGIN_BANNER,
  SYNTHETIC_LOGIN_SUCCESS,
  asciiBytes,
  syntheticLoginTui,
  type PtySpawnSpec,
} from './fakePtyBackend.js';

const SPEC: PtySpawnSpec = {
  argv: ['--continue'],
  cwd: '/synthetic/workspace',
  env: { PATH: '/usr/bin' },
  cols: 80,
  rows: 24,
};

describe('FakePtyBackend', () => {
  it('records spawns, hands out monotonic pids, and describes the fake executable', () => {
    const backend = new FakePtyBackend({ firstPid: 61_001 });
    const first = backend.spawn(SPEC);
    const second = backend.spawn({ ...SPEC, argv: ['--resume', 'ses_synth1'] });
    expect(backend.describeExecutable()).toBe(FAKE_PTY_EXECUTABLE);
    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[1]?.argv).toEqual(['--resume', 'ses_synth1']);
    expect(first.pid).toBe(61_001);
    expect(second.pid).toBe(61_002);
    expect(backend.latest().pid).toBe(61_002);
  });

  it('failSpawn throws from spawn() and records nothing (spawn-failure settlement)', () => {
    const backend = new FakePtyBackend({
      failSpawn: (spec) => (spec.argv.includes('--boom') ? new Error('synthetic spawn refusal') : undefined),
    });
    expect(() => backend.spawn({ ...SPEC, argv: ['--boom'] })).toThrow('synthetic spawn refusal');
    expect(backend.spawns).toHaveLength(0);
    expect(() => backend.latest()).toThrow('nothing spawned yet');
  });

  it('scripts run on the NEXT microtask, after the host wired listeners', async () => {
    const backend = new FakePtyBackend({ script: (proc) => proc.emitText('late enough') });
    const proc = backend.spawn(SPEC) as FakePtyProcess;
    const seen: string[] = [];
    // Listener wired synchronously after spawn — the script must not have run.
    proc.onData((bytes) => seen.push(String.fromCharCode(...bytes)));
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual(['late enough']);
  });
});

describe('FakePtyProcess', () => {
  it('records writes/resizes, settles exit exactly once, and refuses IO after exit', () => {
    const proc = new FakePtyProcess(61_101, SPEC);
    const exits: number[] = [];
    proc.onExit((event) => exits.push(event.exitCode));
    proc.write(asciiBytes('ls\r'));
    proc.resize(120, 40);
    proc.exit(3);
    proc.exit(9); // second exit is a no-op — settlement is single-shot
    expect(proc.alive).toBe(false);
    expect(exits).toEqual([3]);
    expect(proc.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(() => proc.write(asciiBytes('x'))).toThrow('write after exit');
    expect(() => proc.emitData(asciiBytes('x'))).toThrow('emitData after exit');
  });

  it('graceful kill exits 0; SIGKILL exits 137; ignoreGracefulSignals needs the escalation', () => {
    const graceful = new FakePtyProcess(61_102, SPEC);
    graceful.kill();
    expect(graceful.signals).toEqual(['SIGHUP']);
    expect(graceful.alive).toBe(false);

    const stubborn = new FakePtyProcess(61_103, SPEC);
    stubborn.ignoreGracefulSignals = true;
    stubborn.kill('SIGTERM');
    expect(stubborn.alive).toBe(true); // grace ignored — escalation required
    stubborn.kill('SIGKILL');
    expect(stubborn.alive).toBe(false);
    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('syntheticLoginTui + asciiBytes (the [X2] synthetic byte source)', () => {
  it('banner on spawn, opaque echo, exit 0 on the CR-terminated fake code', async () => {
    const backend = new FakePtyBackend({ script: syntheticLoginTui });
    const proc = backend.spawn(SPEC) as FakePtyProcess;
    const chunks: Uint8Array[] = [];
    let exitCode: number | undefined;
    proc.onData((bytes) => chunks.push(bytes));
    proc.onExit((event) => {
      exitCode = event.exitCode;
    });
    await Promise.resolve(); // script microtask
    const decode = (parts: Uint8Array[]): string =>
      parts.map((part) => String.fromCharCode(...part)).join('');
    expect(decode(chunks)).toBe(SYNTHETIC_LOGIN_BANNER);

    proc.write(asciiBytes('synthetic-oauth-code\r'));
    expect(decode(chunks)).toBe(SYNTHETIC_LOGIN_BANNER + SYNTHETIC_LOGIN_SUCCESS);
    expect(exitCode).toBe(0);
    expect(proc.writes).toHaveLength(1); // input still recorded (opaque echo)
  });

  it('asciiBytes masks to 7-bit — pixels only, no encoding layer', () => {
    const bytes = asciiBytes('Aÿ');
    expect([...bytes]).toEqual([0x41, 0x7f]);
  });

  it('the banner is loudly synthetic (fixture identity, [X2])', () => {
    expect(SYNTHETIC_LOGIN_BANNER).toContain('SYNTHETIC-CLAUDE');
    expect(SYNTHETIC_LOGIN_BANNER).toContain('[X2 synthesized]');
  });
});
