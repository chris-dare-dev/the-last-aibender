/**
 * ptyHost — attended sessions, login bootstrap, recycle v0 (plan §9.2 BE-2
 * rows; blueprint §4.1; ws-protocol.md §5/§6 producer side).
 *
 * Positive: TUI bytes stream to the attached consumer as offset frames;
 * resize propagates; login bootstrap runs the synthetic TUI end-to-end; the
 * spawn env comes from buildSessionEnv (asserted byte-for-byte).
 * Negative: substrate/label/cwd refusals; --bare refusal; watermark range
 * errors; liveSpawn gate on the real backend.
 * Edge: detach/reattach mid-output with replay; flow-control pause/resume;
 * recycle during active output (checkpoint → kill → resume + continuation
 * edge); recycle refusals; shutdown.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LaunchParams, PtyFrame } from '@aibender/protocol';
import { decodePtyFrame, encodePtyFrame } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import {
  FakePtyBackend,
  GOLDEN_WS_FIXTURES,
  SYNTHETIC_LOGIN_BANNER,
  SYNTHETIC_LOGIN_SUCCESS,
  asciiBytes,
  syntheticLoginTui,
} from '@aibender/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSessionEnv } from '../env.js';
import { KernelError, LiveSpawnDisabledError } from '../errors.js';
import { createProfileRegistry } from '../profiles.js';
import { createNodePtySpawner } from './ptyBackend.js';
import {
  createPtyHost,
  defaultPtyArgv,
  type ContinuationEdgeEvent,
  type PtyHost,
  type PtyHostOptions,
} from './ptyHost.js';

const HOME = join(mkdtempSync(join(tmpdir(), 'aibender-pty-')), 'home');

const BASE_ENV: Record<string, string | undefined> = {
  PATH: '/usr/bin:/bin',
  HOME: '/synthetic/home',
  ANTHROPIC_API_KEY: 'fake-scrub-me', // must be scrubbed by the spawn layer
};

const LAUNCH: LaunchParams = {
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'pty',
  cwd: '/synthetic/workspace',
  purpose: 'attended cockpit',
};

interface Harness {
  store: KernelStore;
  backend: FakePtyBackend;
  host: PtyHost;
  edges: ContinuationEdgeEvent[];
}

const open: Harness[] = [];

async function makeHost(
  overrides: Partial<PtyHostOptions> & { backendOptions?: ConstructorParameters<typeof FakePtyBackend>[0] } = {},
): Promise<Harness> {
  const store = await openKernelStore({ path: ':memory:' });
  const { backendOptions, ...hostOverrides } = overrides;
  const backend = new FakePtyBackend(backendOptions);
  const edges: ContinuationEdgeEvent[] = [];
  let n = 0;
  const host = createPtyHost({
    ledger: store.resumeLedger,
    profiles: createProfileRegistry({ aibenderHome: HOME }),
    backend,
    baseEnv: BASE_ENV,
    edges: { emitContinuationEdge: (event) => edges.push(event) },
    newSessionUuid: () => `f0000000-0000-4000-8000-00000000000${(n++ % 10).toString()}`,
    forceKillAfterMs: 200,
    ...hostOverrides,
  });
  const harness = { store, backend, host, edges };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.host.shutdown();
    harness.store.close();
  }
  vi.useRealTimers();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function frameText(frames: readonly PtyFrame[]): string {
  return frames.map((frame) => String.fromCharCode(...frame.payload)).join('');
}

/** The protocol ErrorCode a synchronous call refuses with (undefined = none). */
function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (cause) {
    expect(cause).toBeInstanceOf(KernelError);
    return (cause as KernelError).code;
  }
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe('ptyHost — positive', () => {
  it('streams TUI bytes to the attached consumer as offset-stamped OUTPUT frames', async () => {
    const { host, backend } = await makeHost();
    const session = await host.launchAttended(LAUNCH);
    const frames: PtyFrame[] = [];
    session.attach((frame) => frames.push(frame));

    backend.latest().emitText('hello ');
    backend.latest().emitText('cockpit');

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: 'output', sessionId: session.sessionId, streamOffset: 0 });
    expect(frames[1]?.streamOffset).toBe(6);
    expect(frameText(frames)).toBe('hello cockpit');
    // frames round-trip the FROZEN binary codec (the wire the gateway sends)
    for (const frame of frames) {
      const decoded = decodePtyFrame(encodePtyFrame(frame));
      expect(decoded.ok).toBe(true);
    }
  });

  it('spawn env is EXACTLY buildSessionEnv output (the one spawn layer, asserted)', async () => {
    const { host, backend } = await makeHost();
    await host.launchAttended(LAUNCH);

    const profiles = createProfileRegistry({ aibenderHome: HOME });
    const expected = buildSessionEnv(profiles.resolve('MAX_A'), { baseEnv: BASE_ENV });
    expect(backend.latest().spec.env).toEqual(expected);
    // and the scrub actually removed the hijack var from the child env
    expect(backend.latest().spec.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(backend.latest().spec.env['CLAUDE_CONFIG_DIR']).toBe(join(HOME, 'accounts', 'max-a'));
    expect(backend.latest().spec.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(
      join(HOME, 'accounts', 'max-a'),
    );
  });

  it('row-before-spawn: the spawning row exists before the backend forks', async () => {
    const seen: { state: string | undefined; spawns: number }[] = [];
    const harness = await makeHost({
      testHooks: {
        afterLedgerInsert: (sessionId) => {
          seen.push({
            state: harness.store.resumeLedger.get(sessionId)?.state,
            spawns: harness.backend.spawns.length,
          });
        },
      },
    });
    await harness.host.launchAttended(LAUNCH);
    expect(seen).toEqual([{ state: 'spawning', spawns: 0 }]);
  });

  it('backfills the ACTUAL child pid with the argv-visible uuid nonce and pins the native id', async () => {
    const { host, backend, store } = await makeHost();
    const session = await host.launchAttended(LAUNCH);
    const row = store.resumeLedger.get(session.sessionId);
    expect(row?.pid).toBe(backend.latest().pid);
    expect(row?.spawnNonce).toBe('f0000000-0000-4000-8000-000000000000');
    expect(backend.latest().spec.argv).toEqual([
      '--session-id',
      'f0000000-0000-4000-8000-000000000000',
    ]);
    expect(row?.nativeSessionId).toBe('f0000000-0000-4000-8000-000000000000');
    expect(row?.state).toBe('running');
    expect(row?.substrate).toBe('pty');
  });

  it('resize propagates within the frozen bounds; INPUT bytes reach the child', async () => {
    const { host, backend } = await makeHost();
    const session = await host.launchAttended(LAUNCH);
    session.resize(200, 50);
    expect(backend.latest().resizes).toEqual([{ cols: 200, rows: 50 }]);
    session.write(asciiBytes('ls\r'));
    expect(backend.latest().writes).toHaveLength(1);
    expect(String.fromCharCode(...backend.latest().writes[0]!)).toBe('ls\r');
  });

  it('golden pty client fixtures drive the host verbs for a pinned session id', async () => {
    const { host, backend } = await makeHost({ newSessionId: () => 'ses_fake_1' });
    const session = await host.launchAttended(LAUNCH);
    expect(session.sessionId).toBe('ses_fake_1');
    session.attach(() => undefined);
    backend.latest().emitText('0123456789');

    const byName = new Map(GOLDEN_WS_FIXTURES.map((fixture) => [fixture.name, fixture]));
    const payloadOf = (name: string): Record<string, unknown> => {
      const fixture = byName.get(name);
      if (fixture === undefined || fixture.kind !== 'text') throw new Error(`missing golden ${name}`);
      return (JSON.parse(fixture.frame) as { payload: Record<string, unknown> }).payload;
    };

    // pty-ack-valid: { sessionId: 'ses_fake_1', watermark } — apply verbatim
    const ack = payloadOf('pty-ack-valid');
    expect(ack['sessionId']).toBe('ses_fake_1');
    session.ack(Math.min(ack['watermark'] as number, session.producedOffset()));

    // pty-resize-valid drives the same verb the wire carries
    const resize = payloadOf('pty-resize-valid');
    session.resize(resize['cols'] as number, resize['rows'] as number);
    expect(backend.latest().resizes.at(-1)).toEqual({
      cols: resize['cols'],
      rows: resize['rows'],
    });

    // golden INPUT binary frame → write path (payload bytes verbatim)
    const inputFixture = GOLDEN_WS_FIXTURES.find(
      (fixture) => fixture.kind === 'binary' && fixture.decoded?.type === 'input',
    );
    expect(inputFixture).toBeDefined();
    if (inputFixture?.kind === 'binary' && inputFixture.decoded !== undefined) {
      session.write(new TextEncoder().encode(inputFixture.decoded.payloadUtf8));
      expect(String.fromCharCode(...backend.latest().writes.at(-1)!)).toBe(
        inputFixture.decoded.payloadUtf8,
      );
    }
  });

  it('login bootstrap: fresh profile → attended /login TUI → exit settles the row', async () => {
    const { host, backend, store } = await makeHost({
      backendOptions: { script: syntheticLoginTui },
    });
    const session = await host.launchLoginBootstrap({ accountLabel: 'ENT' });
    const frames: PtyFrame[] = [];
    session.attach((frame) => frames.push(frame));

    await settle(); // synthetic TUI banner lands on the microtask queue
    expect(frameText(frames)).toBe(SYNTHETIC_LOGIN_BANNER);

    session.write(asciiBytes('fake-code\r')); // paste + enter
    const exit = await session.waitForExit();
    expect(exit).toMatchObject({ finalState: 'exited', exitCode: 0 });
    expect(frameText(frames)).toBe(SYNTHETIC_LOGIN_BANNER + SYNTHETIC_LOGIN_SUCCESS);

    const row = store.resumeLedger.get(session.sessionId);
    expect(row?.purpose).toBe('login-bootstrap');
    expect(row?.state).toBe('exited');
    // argv is the runbook's /login prompt; env is the account's dir pair
    expect(backend.latest().spec.argv).toEqual(['/login']);
    expect(backend.latest().spec.env['CLAUDE_CONFIG_DIR']).toBe(join(HOME, 'accounts', 'ent'));
    // no native id was pinned (nothing parsed from bytes, no --session-id)
    expect(row?.nativeSessionId).toBeNull();
    // conservative executable-path nonce (see nonce discipline)
    expect(row?.spawnNonce).toBe(backend.describeExecutable());
  });

  it('onSession replays live sessions synchronously then announces future spawns', async () => {
    const { host } = await makeHost();
    const first = await host.launchAttended(LAUNCH);
    const seen: string[] = [];
    host.onSession((session) => seen.push(session.sessionId));
    expect(seen).toEqual([first.sessionId]); // synchronous replay
    const second = await host.launchAttended({ ...LAUNCH, accountLabel: 'MAX_B' });
    expect(seen).toEqual([first.sessionId, second.sessionId]);
  });
});

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

describe('ptyHost — negative', () => {
  it('refuses the sdk substrate (that lane belongs to the session kernel)', async () => {
    const { host } = await makeHost();
    await expect(host.launchAttended({ ...LAUNCH, substrate: 'sdk' })).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('refuses non-Claude labels and label/backend mismatches', async () => {
    const { host } = await makeHost();
    await expect(
      host.launchAttended({ ...LAUNCH, accountLabel: 'AWS_DEV', backend: 'opencode' }),
    ).rejects.toMatchObject({ code: 'bad-request' });
    await expect(
      host.launchAttended({ ...LAUNCH, backend: 'opencode' }),
    ).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('refuses a relative cwd and a launch prompt', async () => {
    const { host } = await makeHost();
    await expect(host.launchAttended({ ...LAUNCH, cwd: 'relative/dir' })).rejects.toMatchObject({
      code: 'bad-request',
    });
    await expect(host.launchAttended({ ...LAUNCH, prompt: 'hi' })).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('refuses --bare from a custom argv strategy (assertNoForbiddenArgs on every spawn)', async () => {
    const { host, store } = await makeHost({ argv: () => ['--bare'] });
    await expect(host.launchAttended(LAUNCH)).rejects.toMatchObject({
      name: 'BareModeRefusedError',
    });
    // the row-before-spawn row settled instead of leaking
    const rows = store.resumeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('exited');
  });

  it('spawn failure settles the row and rethrows', async () => {
    const { host, store } = await makeHost({
      backendOptions: { failSpawn: () => new Error('synthetic fork failure') },
    });
    await expect(host.launchAttended(LAUNCH)).rejects.toThrow('synthetic fork failure');
    expect(store.resumeLedger.list()[0]?.state).toBe('exited');
  });

  it('rejects resize out of the frozen bounds with a typed bad-request', async () => {
    const { host } = await makeHost();
    const session = await host.launchAttended(LAUNCH);
    for (const [cols, rows] of [
      [0, 10],
      [10, 0],
      [4097, 10],
      [10, 4097],
      [1.5, 10],
    ] as const) {
      expect(() => session.resize(cols, rows)).toThrow(KernelError);
    }
  });

  it('answers watermark-out-of-range for over-acks and below-floor replays', async () => {
    const { host, backend } = await makeHost();
    const session = await host.launchAttended(LAUNCH);
    session.attach(() => undefined);
    backend.latest().emitText('abcdef');

    expect(thrownCode(() => session.ack(7))).toBe('watermark-out-of-range');
    session.ack(4); // release abcd
    expect(thrownCode(() => session.replay(3))).toBe('watermark-out-of-range');
    // stale ack is IGNORED, not an error (§6 monotonic rule)
    expect(() => session.ack(2)).not.toThrow();
  });

  it('write/resize on a dead session answer bad-request', async () => {
    const { host, backend } = await makeHost();
    const session = await host.launchAttended(LAUNCH);
    backend.latest().exit(0);
    await session.waitForExit();
    expect(thrownCode(() => session.write(asciiBytes('x')))).toBe('bad-request');
    expect(thrownCode(() => session.resize(80, 24))).toBe('bad-request');
    // but the retained ring still replays (serialize-addon reattach path)
    expect(session.replay(0)).toEqual([]);
  });

  it('the REAL node-pty spawner is liveSpawn opt-in gated (same gate as the SDK runner)', () => {
    expect(() => createNodePtySpawner({ liveSpawnOptIn: false })).toThrow(LiveSpawnDisabledError);
    expect(() =>
      createNodePtySpawner({ liveSpawnOptIn: false, pathToClaudeCodeExecutable: '/tmp/x' }),
    ).toThrow(LiveSpawnDisabledError);
  });

  it('recycle refuses unknown and non-live sessions', async () => {
    const { host, backend } = await makeHost();
    await expect(host.recycle('ses_nope')).rejects.toMatchObject({ code: 'session-not-found' });
    const session = await host.launchAttended(LAUNCH);
    backend.latest().exit(0);
    await session.waitForExit();
    await expect(host.recycle(session.sessionId)).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('recycle refuses (without killing) a session that never got a native id', async () => {
    // login-bootstrap sessions have no native id — the recycle guard case.
    const { host, backend } = await makeHost({
      backendOptions: {
        /* no script: TUI stays alive */
      },
    });
    const session = await host.launchLoginBootstrap({ accountLabel: 'MAX_A' });
    await expect(host.recycle(session.sessionId)).rejects.toMatchObject({
      code: 'session-not-resumable',
    });
    expect(session.isLive()).toBe(true); // untouched
    expect(backend.latest().signals).toEqual([]); // nothing was killed
  });
});

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

describe('ptyHost — edge', () => {
  it('detach mid-output retains bytes; reattach replays from the watermark with stable offsets', async () => {
    const { host, backend } = await makeHost();
    const session = await host.launchAttended(LAUNCH);

    const before: PtyFrame[] = [];
    session.attach((frame) => before.push(frame));
    backend.latest().emitText('first|');
    session.ack(3); // client consumed 'fir'
    session.detach();

    backend.latest().emitText('while-detached|'); // keeps flowing into the ring
    backend.latest().emitText('tail');

    const after: PtyFrame[] = [];
    session.attach((frame) => after.push(frame), { replayFrom: 3 });
    // replay starts EXACTLY at the client watermark; offsets are absolute
    expect(after[0]?.streamOffset).toBe(3);
    expect(frameText(after)).toBe('st|while-detached|tail');

    // live flow continues seamlessly after the replay
    backend.latest().emitText('+live');
    expect(frameText(after)).toBe('st|while-detached|tail+live');
    const last = after.at(-1);
    expect(last?.streamOffset).toBe('first|while-detached|tail'.length);
  });

  it('flow control: an unacked consumer pauses the child at highWater; ack resumes it', async () => {
    const { host, backend } = await makeHost({
      flowControl: { capBytes: 64, highWaterBytes: 32, lowWaterBytes: 8 },
    });
    const session = await host.launchAttended(LAUNCH);
    session.attach(() => undefined); // delivers but never acks

    backend.latest().emitData(new Uint8Array(31));
    expect(backend.latest().paused).toBe(false);
    backend.latest().emitData(new Uint8Array(2)); // occupancy 33 >= 32
    expect(backend.latest().paused).toBe(true); // pty.pause() reached the child

    session.ack(30); // drain to occupancy 3 <= lowWater 8
    expect(backend.latest().paused).toBe(false); // pty.resume() reached the child
  });

  it('a detached session still backpressures instead of ballooning (bounded by design)', async () => {
    const { host, backend } = await makeHost({
      flowControl: { capBytes: 64, highWaterBytes: 32, lowWaterBytes: 8 },
    });
    await host.launchAttended(LAUNCH);
    backend.latest().emitData(new Uint8Array(32)); // no consumer at all
    expect(backend.latest().paused).toBe(true);
  });

  it('recycle during active output: checkpoint → kill → same-node resume + continuation edge, offsets continue', async () => {
    const order: string[] = [];
    const harness = await makeHost({
      testHooks: { onCheckpoint: () => order.push('checkpoint') },
    });
    const { host, backend, store, edges } = harness;
    const session = await host.launchAttended(LAUNCH);
    const frames: PtyFrame[] = [];
    session.attach((frame) => frames.push(frame));

    backend.latest().emitText('mid-tool-call output..'); // active output stream
    const firstPid = backend.latest().pid;
    const producedBefore = session.producedOffset();

    const originalKill = backend.latest().kill.bind(backend.latest());
    backend.latest().kill = (signal): void => {
      order.push(`kill:${signal ?? 'SIGHUP'}`);
      originalKill(signal);
    };

    const outcome = await host.recycle(session.sessionId);
    expect(outcome.forkedFrom).toBeUndefined();
    expect(outcome.session.sessionId).toBe(session.sessionId);
    expect(order).toEqual(['checkpoint', 'kill:SIGHUP']); // checkpoint precedes kill

    const row = store.resumeLedger.get(session.sessionId);
    expect(row?.state).toBe('resumed'); // running → resumed via the M1 FSM
    expect(row?.pid).toBe(backend.latest().pid);
    expect(backend.latest().pid).not.toBe(firstPid);
    // the new child resumes the SAME native session
    expect(backend.latest().spec.argv).toEqual([
      '--resume',
      'f0000000-0000-4000-8000-000000000000',
    ]);

    // [X4] continuation edge, same node (continuation = this session)
    expect(edges).toEqual([
      expect.objectContaining({
        edge: 'continue',
        fromSessionId: session.sessionId,
        toSessionId: session.sessionId,
        reason: 'recycle',
      }),
    ]);

    // byte axis is CONTINUOUS across the recycle (serialize-friendly)
    backend.latest().emitText('post-recycle');
    const last = frames.at(-1);
    expect(last?.streamOffset).toBe(producedBefore);
    expect(frameText(frames)).toBe('mid-tool-call output..post-recycle');
    expect(session.isLive()).toBe(true);
  });

  it('fork-recycle settles the parent and spawns a continuation CHILD with its own row and edge', async () => {
    const { host, backend, store, edges } = await makeHost();
    const parent = await host.launchAttended({ ...LAUNCH, workstreamHint: 'ws_fake' });
    backend.latest().emitText('parent output');

    const outcome = await host.recycle(parent.sessionId, { fork: true });
    expect(outcome.forkedFrom).toBe(parent.sessionId);
    expect(outcome.session.sessionId).not.toBe(parent.sessionId);

    const parentRow = store.resumeLedger.get(parent.sessionId);
    const childRow = store.resumeLedger.get(outcome.session.sessionId);
    expect(parentRow?.state).toBe('exited');
    expect(childRow?.state).toBe('running');
    expect(childRow?.substrate).toBe('pty');
    expect(childRow?.workstreamHint).toBe('ws_fake');
    expect(backend.latest().spec.argv).toEqual([
      '--resume',
      'f0000000-0000-4000-8000-000000000000',
      '--fork-session',
    ]);
    expect(edges).toEqual([
      expect.objectContaining({
        edge: 'continue',
        fromSessionId: parent.sessionId,
        toSessionId: outcome.session.sessionId,
      }),
    ]);
    // child starts a FRESH byte axis (new session, new pty channel)
    expect(outcome.session.producedOffset()).toBe(0);
    await parent.waitForExit(); // parent settled
  });

  it('recycle escalates to force when the child ignores the graceful hangup', async () => {
    vi.useFakeTimers();
    const { host, backend } = await makeHost({ forceKillAfterMs: 200 });
    const session = await host.launchAttended(LAUNCH);
    backend.latest().ignoreGracefulSignals = true;

    const recycling = host.recycle(session.sessionId);
    await vi.advanceTimersByTimeAsync(250);
    const outcome = await recycling;
    expect(outcome.session.sessionId).toBe(session.sessionId);
    expect(backend.processes[0]?.signals).toEqual(['SIGHUP', 'SIGKILL']);
    expect(session.isLive()).toBe(true);
  });

  it('launch raced with shutdown settles the recoverable row and refuses', async () => {
    const harness = await makeHost({
      testHooks: {
        afterLedgerInsert: () => {
          void harness.host.shutdown();
        },
      },
    });
    await expect(harness.host.launchAttended(LAUNCH)).rejects.toMatchObject({
      name: 'KernelShutdownError',
    });
    expect(harness.backend.spawns).toHaveLength(0); // no child was forked
    expect(harness.store.resumeLedger.list()[0]?.state).toBe('exited');
  });

  it('shutdown force-kills live children and settles every row', async () => {
    const { host, backend, store } = await makeHost();
    const a = await host.launchAttended(LAUNCH);
    const b = await host.launchAttended({ ...LAUNCH, accountLabel: 'MAX_B' });
    await host.shutdown();
    expect(backend.processes.every((proc) => !proc.alive)).toBe(true);
    expect(store.resumeLedger.get(a.sessionId)?.state).toBe('exited');
    expect(store.resumeLedger.get(b.sessionId)?.state).toBe('exited');
    await expect(host.launchAttended(LAUNCH)).rejects.toMatchObject({
      name: 'KernelShutdownError',
    });
  });

  it('default argv strategy is the documented T3 contract', () => {
    expect(defaultPtyArgv({ kind: 'attended', sessionUuid: 'u-1' })).toEqual(['--session-id', 'u-1']);
    expect(defaultPtyArgv({ kind: 'login-bootstrap', sessionUuid: 'u-2' })).toEqual(['/login']);
    expect(
      defaultPtyArgv({ kind: 'recycle-resume', sessionUuid: 'u-3', nativeSessionId: 'n-1' }),
    ).toEqual(['--resume', 'n-1']);
    expect(
      defaultPtyArgv({
        kind: 'recycle-resume',
        sessionUuid: 'u-4',
        nativeSessionId: 'n-1',
        fork: true,
      }),
    ).toEqual(['--resume', 'n-1', '--fork-session']);
  });
});
