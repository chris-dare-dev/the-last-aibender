import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { LaunchParams } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { newId } from '@aibender/shared';
// Promoted doubles (ICR-0001): FakeQueryRunner + synthesizedTranscript moved
// from ./testing/ into @aibender/testkit — same API, new home.
import {
  FakeQueryRunner,
  synthesizedTranscript,
  type FakeQueryRunnerOptions,
} from '@aibender/testkit';

import {
  DoubleResumeError,
  KernelError,
  KernelShutdownError,
  SessionNotFoundKernelError,
  SessionNotResumableError,
  TokenMixingError,
  UnknownProfileError,
} from './errors.js';
import { createProfileRegistry } from './profiles.js';
import { createSessionKernel, projectDirSlug, type SessionKernelOptions } from './sessionKernel.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HOME = '/synthetic/aibender-home';
const CWD = '/synthetic/workspace';

const stores: KernelStore[] = [];
const scratchDirs: string[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

async function harness(options: {
  readonly runner?: FakeQueryRunnerOptions;
  readonly kernel?: Partial<SessionKernelOptions>;
} = {}) {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const runner = new FakeQueryRunner(options.runner ?? {});
  const profiles = createProfileRegistry({ aibenderHome: HOME });
  const kernel = createSessionKernel({
    ledger: store.resumeLedger,
    profiles,
    runner,
    baseEnv: { PATH: '/usr/bin' },
    ...options.kernel,
  });
  return { store, runner, profiles, kernel };
}

function launchParams(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate: 'sdk',
    cwd: CWD,
    purpose: 'synthesized kernel test session',
    prompt: 'synthesized prompt',
    ...overrides,
  };
}

/** Fabricate a dead session row (a previous broker life) directly in the ledger. */
function fabricateDeadSession(
  store: KernelStore,
  options: {
    readonly nativeSessionId?: string | null;
    readonly cwd?: string;
    /** Backfill pid + spawn nonce (SPIKE-D finding 2 columns). */
    readonly pid?: number;
    readonly spawnNonce?: string;
  } = {},
): string {
  const id = newId('ses');
  store.resumeLedger.insertBeforeSpawn({
    id,
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    cwd: options.cwd ?? CWD,
    substrate: 'sdk',
    purpose: 'synthesized dead session',
  });
  store.resumeLedger.transition(id, 'running');
  if (options.pid !== undefined) {
    store.resumeLedger.backfillPid(id, options.pid, options.spawnNonce ?? 'synth-nonce');
  }
  if (options.nativeSessionId !== null) {
    store.resumeLedger.backfillNativeSessionId(
      id,
      options.nativeSessionId ?? 'synth-native-session',
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe('SessionKernel — launch (positive)', () => {
  it("spawn env contains the account's config + securestorage dirs and the scrub applied", async () => {
    const { runner, kernel } = await harness({
      kernel: {
        baseEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'fake-hijacker',
          CLAUDE_CODE_USE_BEDROCK: '1',
        },
      },
    });
    const session = await kernel.launch(launchParams());
    await session.waitForExit();

    const spec = runner.starts[0];
    expect(spec).toBeDefined();
    expect(spec?.env['CLAUDE_CONFIG_DIR']).toBe(join(HOME, 'accounts', 'max-a'));
    expect(spec?.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(join(HOME, 'accounts', 'max-a'));
    expect(spec?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(spec?.env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(spec?.env['OTEL_RESOURCE_ATTRIBUTES']).toBe('account=MAX_A');
  });

  it('THE ordering proof: the ledger row exists (state=spawning) when the runner spawns', async () => {
    const observed: { state?: string | undefined; existed?: boolean } = {};
    const { store, kernel } = await (async () => {
      const store = await openKernelStore({ path: ':memory:' });
      stores.push(store);
      const runner = new FakeQueryRunner({
        onStart: (spec) => {
          const row = store.resumeLedger.get(spec.sessionId);
          observed.existed = row !== undefined;
          observed.state = row?.state;
        },
      });
      const kernel = createSessionKernel({
        ledger: store.resumeLedger,
        profiles: createProfileRegistry({ aibenderHome: HOME }),
        runner,
        baseEnv: {},
      });
      return { store, kernel };
    })();

    const session = await kernel.launch(launchParams());
    await session.waitForExit();

    expect(observed.existed).toBe(true); // row BEFORE spawn — SPIKE-D vii
    expect(observed.state).toBe('spawning');
    expect(store.resumeLedger.get(session.sessionId)?.state).toBe('exited');
  });

  it('backfills native_session_id from the init message and pid+nonce from the handle', async () => {
    const { store, kernel } = await harness({ runner: { providePids: true } });
    const session = await kernel.launch(launchParams());
    await session.waitForExit();

    const row = store.resumeLedger.get(session.sessionId);
    expect(row?.nativeSessionId).toBe('fake-native-0');
    expect(row?.pid).toBe(40_000);
    expect(row?.spawnNonce).toBe('fake-nonce-0');
  });

  it('surfaces the terminal result and settles the FSM at exited', async () => {
    const { store, kernel } = await harness();
    const session = await kernel.launch(launchParams());
    const exit = await session.waitForExit();
    expect(exit.result?.ok).toBe(true);
    expect(exit.result?.detail).toBe('success');
    expect(store.resumeLedger.get(session.sessionId)?.state).toBe('exited');
    expect(kernel.isLive(session.sessionId)).toBe(false);
  });

  it('status() projects the wire shape (protocol SessionStatus)', async () => {
    const { kernel } = await harness();
    const session = await kernel.launch(launchParams({ workstreamHint: 'ws-synth' }));
    await session.waitForExit();
    const [status] = kernel.status(session.sessionId);
    expect(status).toMatchObject({
      sessionId: session.sessionId,
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      state: 'exited',
      cwd: CWD,
      workstreamHint: 'ws-synth',
      nativeSessionId: 'fake-native-0',
    });
  });
});

describe('SessionKernel — concurrency ([X1] M1 acceptance shape)', () => {
  it('three sessions on three profiles run concurrently in one process with distinct, uncontaminated env', async () => {
    const { store, runner, kernel } = await harness({ runner: { mode: 'manual' } });

    const [a, b, c] = await Promise.all([
      kernel.launch(launchParams({ accountLabel: 'MAX_A' })),
      kernel.launch(launchParams({ accountLabel: 'MAX_B' })),
      kernel.launch(launchParams({ accountLabel: 'ENT' })),
    ]);

    // All three are live simultaneously in this one process.
    expect(kernel.isLive(a.sessionId)).toBe(true);
    expect(kernel.isLive(b.sessionId)).toBe(true);
    expect(kernel.isLive(c.sessionId)).toBe(true);

    // Distinct env per session; every value points at its OWN account.
    const byLabel = new Map(runner.starts.map((spec) => [spec.env['OTEL_RESOURCE_ATTRIBUTES'], spec]));
    expect(byLabel.size).toBe(3);
    const expectations = [
      ['account=MAX_A', 'max-a'],
      ['account=MAX_B', 'max-b'],
      ['account=ENT', 'ent'],
    ] as const;
    for (const [attr, dir] of expectations) {
      const spec = byLabel.get(attr);
      expect(spec, `spec for ${attr}`).toBeDefined();
      expect(spec?.env['CLAUDE_CONFIG_DIR']).toBe(join(HOME, 'accounts', dir));
      expect(spec?.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(join(HOME, 'accounts', dir));
    }

    // No cross-contamination: the three env objects are independent snapshots.
    const configDirs = new Set(runner.starts.map((spec) => spec.env['CLAUDE_CONFIG_DIR']));
    expect(configDirs.size).toBe(3);

    // Each completes independently.
    runner.session(a.sessionId).complete();
    runner.session(b.sessionId).complete();
    runner.session(c.sessionId).complete();
    await Promise.all([a.waitForExit(), b.waitForExit(), c.waitForExit()]);
    for (const session of [a, b, c]) {
      expect(store.resumeLedger.get(session.sessionId)?.state).toBe('exited');
    }
  });
});

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

describe('SessionKernel — refusals (negative)', () => {
  it('rejects an unknown account label with a typed error and writes NO ledger row', async () => {
    const { store, kernel } = await harness();
    await expect(
      kernel.launch(launchParams({ accountLabel: 'MAX_C' as LaunchParams['accountLabel'] })),
    ).rejects.toBeInstanceOf(UnknownProfileError);
    expect(store.resumeLedger.list()).toHaveLength(0);
  });

  it('rejects label/backend pairing violations', async () => {
    const { kernel } = await harness();
    await expect(
      kernel.launch(launchParams({ backend: 'opencode' })),
    ).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('rejects the pty substrate at M1 (BE-2 territory)', async () => {
    const { kernel } = await harness();
    await expect(kernel.launch(launchParams({ substrate: 'pty' }))).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('rejects a relative cwd and a missing prompt', async () => {
    const { kernel } = await harness();
    await expect(kernel.launch(launchParams({ cwd: 'relative/dir' }))).rejects.toMatchObject({
      code: 'bad-request',
    });
    const noPrompt: LaunchParams = (({ prompt: _prompt, ...rest }) => rest)(launchParams());
    await expect(kernel.launch(noPrompt)).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('refuses CLAUDE_CODE_OAUTH_TOKEN-mixing BEFORE any ledger row exists', async () => {
    const { store, kernel } = await harness({
      kernel: { baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'obviously-fake-not-a-real-token' } },
    });
    await expect(kernel.launch(launchParams())).rejects.toBeInstanceOf(TokenMixingError);
    expect(store.resumeLedger.list()).toHaveLength(0);
  });

  it('blocks un-forked double-resume of a live session (blueprint §5 guardrail)', async () => {
    const { runner, kernel } = await harness({ runner: { mode: 'manual' } });
    const session = await kernel.launch(launchParams());
    expect(kernel.isLive(session.sessionId)).toBe(true);

    await expect(
      kernel.resume(session.sessionId, { prompt: 'continue' }),
    ).rejects.toBeInstanceOf(DoubleResumeError);
    await expect(
      kernel.resume(session.sessionId, { prompt: 'continue' }),
    ).rejects.toMatchObject({ code: 'double-resume-blocked' });

    // Let the pump ingest the init message (native id backfill) before forking.
    await new Promise((resolve) => setImmediate(resolve));

    // Forking the SAME live session is the sanctioned branch operation.
    const fork = await kernel.resume(session.sessionId, { prompt: 'branch', fork: true });
    expect(fork.forkedFrom).toBe(session.sessionId);
    expect(fork.sessionId).not.toBe(session.sessionId);
    const forkSpec = runner.starts.at(-1);
    expect(forkSpec?.forkSession).toBe(true);
    expect(forkSpec?.resumeNativeSessionId).toBe('fake-native-0');

    runner.session(fork.sessionId).complete();
    runner.session(session.sessionId).complete();
    await Promise.all([fork.waitForExit(), session.waitForExit()]);
  });

  it('resume of an unknown session id → session-not-found', async () => {
    const { kernel } = await harness();
    await expect(kernel.resume('ses_missing', { prompt: 'x' })).rejects.toBeInstanceOf(
      SessionNotFoundKernelError,
    );
  });

  it('un-forked resume of an exited session is refused; fork continues it', async () => {
    const { kernel } = await harness();
    const session = await kernel.launch(launchParams());
    await session.waitForExit();

    await expect(
      kernel.resume(session.sessionId, { prompt: 'continue' }),
    ).rejects.toBeInstanceOf(SessionNotResumableError);

    const fork = await kernel.resume(session.sessionId, { prompt: 'continue', fork: true });
    expect(fork.forkedFrom).toBe(session.sessionId);
    await fork.waitForExit();
  });

  it('resume of an orphan_detected session is refused until reaped', async () => {
    const { store, kernel } = await harness();
    const id = fabricateDeadSession(store);
    store.resumeLedger.transition(id, 'orphan_detected');
    await expect(kernel.resume(id, { prompt: 'x' })).rejects.toBeInstanceOf(
      SessionNotResumableError,
    );
  });

  it('a failed spawn settles the row at exited and rejects the launch', async () => {
    const { store, kernel } = await harness({
      runner: { failStart: () => new Error('synthetic spawn failure') },
    });
    await expect(kernel.launch(launchParams())).rejects.toThrow('synthetic spawn failure');
    const rows = store.resumeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('exited'); // recoverable, never untracked
  });

  it('abort of a non-live session is a typed refusal; unknown id is not-found', async () => {
    const { kernel } = await harness();
    const session = await kernel.launch(launchParams());
    await session.waitForExit();
    await expect(kernel.abort(session.sessionId)).rejects.toBeInstanceOf(KernelError);
    await expect(kernel.abort('ses_missing')).rejects.toBeInstanceOf(
      SessionNotFoundKernelError,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

describe('SessionKernel — edges', () => {
  it('non-NFC cwd input is normalized once; ledger and spawn see identical bytes', async () => {
    const { store, runner, kernel } = await harness();
    const nfdCwd = '/synthetic/cafe\u0301/workspace'; // decomposed e + COMBINING ACUTE
    const nfcCwd = nfdCwd.normalize('NFC');
    expect(nfdCwd).not.toBe(nfcCwd);

    const session = await kernel.launch(launchParams({ cwd: nfdCwd }));
    await session.waitForExit();

    const row = store.resumeLedger.get(session.sessionId);
    expect(row?.cwd).toBe(nfcCwd);
    expect(runner.starts[0]?.cwd).toBe(nfcCwd);
    expect(runner.starts[0]?.cwd).toBe(row?.cwd); // byte-identical
  });

  it('spawn raced with shutdown: the crash window settles the row and refuses', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const runner = new FakeQueryRunner();
    let kernelRef: { shutdown(): Promise<void> } | undefined;
    const kernel = createSessionKernel({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      runner,
      baseEnv: {},
      testHooks: {
        afterLedgerInsert: () => {
          void kernelRef?.shutdown(); // shutdown lands INSIDE the spawn window
        },
      },
    });
    kernelRef = kernel;

    await expect(kernel.launch(launchParams())).rejects.toBeInstanceOf(KernelShutdownError);
    const rows = store.resumeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('exited'); // recoverable record, no child forked
    expect(runner.starts).toHaveLength(0); // the spawn never happened

    // And the kernel stays closed for business afterwards.
    await expect(kernel.launch(launchParams())).rejects.toBeInstanceOf(KernelShutdownError);
  });

  it('un-forked dead resume with a SAFE transcript tail resumes the same row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibender-kernel-'));
    scratchDirs.push(dir);
    const fixture = synthesizedTranscript({
      steps: [{ kind: 'user' }, { kind: 'assistant' }, { kind: 'tool-call', paired: true }],
    });
    const transcriptPath = join(dir, 'safe.jsonl');
    writeFileSync(transcriptPath, fixture.jsonl);

    const { store, runner, kernel } = await harness({
      kernel: { transcriptLocator: () => transcriptPath },
    });
    const id = fabricateDeadSession(store);

    const outcome = await kernel.resume(id, { prompt: 'continue' });
    expect(outcome.sessionId).toBe(id); // SAME row — no fork
    expect(outcome.forkedFrom).toBeUndefined();
    expect(outcome.repaired).toBeUndefined();

    const spec = runner.starts[0];
    expect(spec?.resumeNativeSessionId).toBe('synth-native-session');
    expect(spec?.forkSession).toBeUndefined();
    await outcome.waitForExit();
    expect(store.resumeLedger.get(id)?.state).toBe('exited');
  });

  it('resume against a truncated/incoherent transcript FORKS from the last coherent message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibender-kernel-'));
    scratchDirs.push(dir);
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'user' },
        { kind: 'assistant' },
        { kind: 'tool-call', paired: false }, // mid-tool-call kill
        { kind: 'torn' },
      ],
    });
    const transcriptPath = join(dir, 'incoherent.jsonl');
    writeFileSync(transcriptPath, fixture.jsonl);

    const { store, runner, kernel } = await harness({
      kernel: { transcriptLocator: () => transcriptPath },
    });
    const id = fabricateDeadSession(store);

    const outcome = await kernel.resume(id, { prompt: 'continue' });
    expect(outcome.repaired).toBe(true);
    expect(outcome.forkedFrom).toBe(id);
    expect(outcome.sessionId).not.toBe(id);

    // The child forked from the last coherent message (the assistant turn
    // BEFORE the dangling tool call).
    const spec = runner.starts[0];
    expect(spec?.forkSession).toBe(true);
    expect(spec?.resumeNativeSessionId).toBe('synth-native-session');
    expect(spec?.resumeSessionAt).toBe(fixture.uuids[1]);

    await outcome.waitForExit();
    // Parent superseded; child settled; native store untouched (read-only path).
    expect(store.resumeLedger.get(id)?.state).toBe('exited');
    expect(store.resumeLedger.get(outcome.sessionId)?.state).toBe('exited');
  });

  it('a dead row with an unusable transcript and no coherent anchor is not resumable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibender-kernel-'));
    scratchDirs.push(dir);
    const transcriptPath = join(dir, 'empty.jsonl');
    writeFileSync(transcriptPath, '');

    const { store, kernel } = await harness({
      kernel: { transcriptLocator: () => transcriptPath },
    });
    const id = fabricateDeadSession(store);
    await expect(kernel.resume(id, { prompt: 'x' })).rejects.toBeInstanceOf(
      SessionNotResumableError,
    );
  });

  it('a missing transcript file skips validation and resumes (SDK is the next gate)', async () => {
    const { store, kernel } = await harness({
      kernel: { transcriptLocator: () => '/synthetic/missing/transcript.jsonl' },
    });
    const id = fabricateDeadSession(store);
    const outcome = await kernel.resume(id, { prompt: 'continue' });
    expect(outcome.sessionId).toBe(id);
    await outcome.waitForExit();
  });

  it('a dead row that never got a native session id cannot be resumed', async () => {
    const { store, kernel } = await harness();
    const id = fabricateDeadSession(store, { nativeSessionId: null });
    await expect(kernel.resume(id, { prompt: 'x' })).rejects.toBeInstanceOf(
      SessionNotResumableError,
    );
  });

  it('abort ends a live session and settles it at exited', async () => {
    const { store, kernel } = await harness({ runner: { mode: 'manual' } });
    const session = await kernel.launch(launchParams());
    expect(kernel.isLive(session.sessionId)).toBe(true);
    const exit = await kernel.abort(session.sessionId);
    expect(exit.finalState).toBe('exited');
    expect(store.resumeLedger.get(session.sessionId)?.state).toBe('exited');
    expect(kernel.isLive(session.sessionId)).toBe(false);
  });

  it('shutdown aborts every live session and blocks new work', async () => {
    const { store, kernel } = await harness({ runner: { mode: 'manual' } });
    const [a, b] = await Promise.all([
      kernel.launch(launchParams({ accountLabel: 'MAX_A' })),
      kernel.launch(launchParams({ accountLabel: 'MAX_B' })),
    ]);
    await kernel.shutdown();
    expect(store.resumeLedger.get(a.sessionId)?.state).toBe('exited');
    expect(store.resumeLedger.get(b.sessionId)?.state).toBe('exited');
    await expect(kernel.launch(launchParams())).rejects.toBeInstanceOf(KernelShutdownError);
    await expect(kernel.resume(a.sessionId, { prompt: 'x' })).rejects.toBeInstanceOf(
      KernelShutdownError,
    );
  });

  it('projectDirSlug mirrors the dash-for-separator convention', () => {
    expect(projectDirSlug('/synthetic/my.project/dir')).toBe('-synthetic-my-project-dir');
  });
});

// ---------------------------------------------------------------------------
// Pid-liveness guard on un-forked dead resume (SPIKE-D finding 2; sqlite-ddl §4:
// running → resumed is legal only after broker AND child death)
// ---------------------------------------------------------------------------

describe('SessionKernel — pid-liveness guard (dead-broker running rows)', () => {
  const MISSING_TRANSCRIPT = () => '/synthetic/missing/transcript.jsonl';

  it('NEGATIVE: running row + alive nonce-verified pid → double-resume-blocked, row untouched', async () => {
    const probed: Array<{ pid: number; nonce: string | null }> = [];
    const { store, kernel } = await harness({
      kernel: {
        transcriptLocator: MISSING_TRANSCRIPT,
        pidProbe: {
          isSameProcessAlive: (pid, nonce) => {
            probed.push({ pid, nonce });
            return true; // the original child is provably still alive
          },
        },
      },
    });
    const id = fabricateDeadSession(store, { pid: 54_321, spawnNonce: 'synth-nonce-alive' });

    await expect(kernel.resume(id, { prompt: 'continue' })).rejects.toBeInstanceOf(
      DoubleResumeError,
    );
    await expect(kernel.resume(id, { prompt: 'continue' })).rejects.toMatchObject({
      code: 'double-resume-blocked',
    });
    expect(probed[0]).toEqual({ pid: 54_321, nonce: 'synth-nonce-alive' });
    // The refusal never mutates the row — reconciliation still owns it.
    expect(store.resumeLedger.get(id)?.state).toBe('running');
  });

  it('probe reports the child dead → un-forked dead resume proceeds on the SAME row', async () => {
    const { store, kernel } = await harness({
      kernel: {
        transcriptLocator: MISSING_TRANSCRIPT,
        pidProbe: { isSameProcessAlive: () => false }, // pid reused or gone
      },
    });
    const id = fabricateDeadSession(store, { pid: 54_322, spawnNonce: 'synth-nonce-dead' });

    const outcome = await kernel.resume(id, { prompt: 'continue' });
    expect(outcome.sessionId).toBe(id);
    expect(outcome.forkedFrom).toBeUndefined();
    await outcome.waitForExit();
    expect(store.resumeLedger.get(id)?.state).toBe('exited');
  });

  it('EDGE: forking a running row with an alive child stays available (sanctioned branch)', async () => {
    const { store, kernel } = await harness({
      kernel: {
        transcriptLocator: MISSING_TRANSCRIPT,
        pidProbe: { isSameProcessAlive: () => true }, // child provably alive
      },
    });
    const id = fabricateDeadSession(store, { pid: 54_323, spawnNonce: 'synth-nonce-branch' });

    // Un-forked is blocked…
    await expect(kernel.resume(id, { prompt: 'continue' })).rejects.toMatchObject({
      code: 'double-resume-blocked',
    });
    // …but the fork branch (continuation CHILD) remains legitimate, exactly
    // like forking a live in-broker session.
    const fork = await kernel.resume(id, { prompt: 'branch', fork: true });
    expect(fork.forkedFrom).toBe(id);
    expect(fork.sessionId).not.toBe(id);
    await fork.waitForExit();
    expect(store.resumeLedger.get(id)?.state).toBe('running'); // parent row untouched
  });

  it('pid-null running rows never consult the probe (SDK stdio-pipe lifetime reasoning)', async () => {
    // WHY resume stays available with no pid to probe (encoded reasoning):
    // the SDK path cannot surface the child pid at 0.3.201, and SDK children
    // share the broker's stdio-pipe lifetime — query() spawns the bundled
    // claude attached via pipes (never detached/setsid, same process group),
    // and a stream-json child exits on stdin EOF when the dead broker's pipe
    // end closes. A child that outlived its broker mid-turn leaves a
    // dangling/torn tail — routed to a repair FORK by the next test.
    const { kernel, store } = await harness({
      kernel: {
        transcriptLocator: MISSING_TRANSCRIPT,
        pidProbe: {
          isSameProcessAlive: () => {
            throw new Error('the probe must not run for pid-null rows');
          },
        },
      },
    });
    const id = fabricateDeadSession(store); // pid stays NULL (SDK path shape)
    const outcome = await kernel.resume(id, { prompt: 'continue' });
    expect(outcome.sessionId).toBe(id);
    await outcome.waitForExit();
  });

  it('pid-null running row with a mid-turn (dangling) tail → repair FORK, never an un-forked re-drive', async () => {
    // The second gate of the pid-null reasoning: any child that could have
    // outlived the broker was mid-turn, and a mid-turn death leaves an
    // unsafe tail — the validator forks from the last coherent message
    // instead of re-driving the same native session un-forked.
    const dir = mkdtempSync(join(tmpdir(), 'aibender-kernel-'));
    scratchDirs.push(dir);
    const fixture = synthesizedTranscript({
      steps: [{ kind: 'user' }, { kind: 'assistant' }, { kind: 'tool-call', paired: false }],
    });
    const transcriptPath = join(dir, 'dangling.jsonl');
    writeFileSync(transcriptPath, fixture.jsonl);

    const { store, kernel } = await harness({
      kernel: { transcriptLocator: () => transcriptPath },
    });
    const id = fabricateDeadSession(store); // pid NULL
    const outcome = await kernel.resume(id, { prompt: 'continue' });
    expect(outcome.repaired).toBe(true);
    expect(outcome.forkedFrom).toBe(id);
    expect(outcome.sessionId).not.toBe(id);
    await outcome.waitForExit();
  });
});
