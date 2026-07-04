import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateControlResponse,
  type ControlRequest,
  type ControlResponse,
  type Envelope,
} from '@aibender/protocol';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';

// FakeQueryRunner was promoted from ../kernel/testing/ into testkit (ICR-0001).
import { FakeQueryRunner, type FakeQueryRunnerOptions } from '@aibender/testkit';

import { composeBroker, composeKernel, DAEMON_NAME, main, type ComposedBroker } from './index.js';
import { readBootstrapFile } from '../gateway/index.js';
import { LiveSpawnDisabledError } from '../kernel/index.js';

describe('aibender-core entry point', () => {
  // -- positive ------------------------------------------------------------

  it('prints exactly one line naming the daemon and returns exit code 0', () => {
    const lines: string[] = [];
    const code = main((line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(DAEMON_NAME);
    expect(DAEMON_NAME).toBe('aibender-core');
  });

  // -- negative ------------------------------------------------------------

  it('never touches console when a custom sink is provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      main(() => {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('did not run its direct-execution side effect under test import', () => {
    // Importing this module (as vitest just did) must not set an exit code.
    expect(process.exitCode ?? 0).toBe(0);
  });

  // -- edge ----------------------------------------------------------------

  it('is idempotent: repeated calls behave identically', () => {
    const first: string[] = [];
    const second: string[] = [];
    expect(main((l) => first.push(l))).toBe(0);
    expect(main((l) => second.push(l))).toBe(0);
    expect(second).toEqual(first);
  });
});

describe('composeKernel — M1 wiring (config → migrations → kernel)', () => {
  // -- positive ------------------------------------------------------------

  it('wires store + profiles + injected runner into a working kernel', async () => {
    const runner = new FakeQueryRunner();
    const composed = await composeKernel({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      runner,
      baseEnv: { PATH: '/usr/bin' },
    });
    try {
      const session = await composed.kernel.launch({
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        substrate: 'sdk',
        cwd: '/synthetic/workspace',
        purpose: 'synthesized wiring test',
        prompt: 'synthesized prompt',
      });
      const exit = await session.waitForExit();
      expect(exit.result?.ok).toBe(true);
      // Migrations applied on open: the ledger row round-trips.
      expect(composed.store.resumeLedger.get(session.sessionId)?.state).toBe('exited');
      expect(runner.starts[0]?.env['CLAUDE_CONFIG_DIR']).toBe(
        '/synthetic/aibender-home/accounts/max-a',
      );
    } finally {
      await composed.close();
    }
  });

  // -- negative ------------------------------------------------------------

  it('DEFAULTS to a refusing runner: no live spawn without explicit opt-in', async () => {
    const composed = await composeKernel({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      baseEnv: {},
    });
    try {
      await expect(
        composed.kernel.launch({
          accountLabel: 'MAX_A',
          backend: 'claude_code',
          substrate: 'sdk',
          cwd: '/synthetic/workspace',
          purpose: 'synthesized refusal test',
          prompt: 'synthesized prompt',
        }),
      ).rejects.toBeInstanceOf(LiveSpawnDisabledError);
      // Row-before-spawn still held: the refusal settled the row at exited.
      const rows = composed.store.resumeLedger.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('exited');
    } finally {
      await composed.close();
    }
  });

  it('liveSpawn: { enabled: false } is the same refusal, typed', async () => {
    const composed = await composeKernel({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      liveSpawn: { enabled: false },
      baseEnv: {},
    });
    try {
      await expect(
        composed.kernel.launch({
          accountLabel: 'MAX_B',
          backend: 'claude_code',
          substrate: 'sdk',
          cwd: '/synthetic/workspace',
          purpose: 'synthesized refusal test',
          prompt: 'synthesized prompt',
        }),
      ).rejects.toBeInstanceOf(LiveSpawnDisabledError);
    } finally {
      await composed.close();
    }
  });

  // -- edge ----------------------------------------------------------------

  it('close() drains the kernel before closing the store (shutdown ordering)', async () => {
    const runner = new FakeQueryRunner({ mode: 'manual' });
    const composed = await composeKernel({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      runner,
      baseEnv: {},
    });
    const session = await composed.kernel.launch({
      accountLabel: 'ENT',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'synthesized shutdown test',
      prompt: 'synthesized prompt',
    });
    expect(composed.kernel.isLive(session.sessionId)).toBe(true);
    await composed.close(); // aborts the live session, THEN closes sqlite
    // If the store had closed first, the pump's final transition would throw.
    await expect(session.waitForExit()).resolves.toMatchObject({ finalState: 'exited' });
  });
});

// ---------------------------------------------------------------------------
// composeBroker — the M1 "BE-3 skeleton sufficient to drive a scripted demo"
// (plan §8.2): WS client → gateway → adaptSessionKernel → REAL kernel over a
// FakeQueryRunner → REAL SQLite ledger. Every broker→client payload is run
// through the FROZEN validateControlResponse (golden cross-check).
// ---------------------------------------------------------------------------

/** Minimal frozen-protocol WS client for the composition round-trips. */
class WireClient {
  private seq = 0;
  private readonly pending = new Map<string, (response: ControlResponse) => void>();

  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data) => {
      const envelope = JSON.parse(String(data)) as Envelope;
      if (envelope.channel !== 'control') return;
      // Golden cross-check: EVERY correlated response the broker sends must
      // pass the frozen client-side validator.
      const parsed = validateControlResponse(envelope.payload);
      if (!parsed.ok) return; // pushed error payloads etc. — not awaited here
      const resolve = this.pending.get(parsed.value.id);
      if (resolve !== undefined) {
        this.pending.delete(parsed.value.id);
        resolve(parsed.value);
      }
    });
    ws.on('error', () => {
      /* close races in teardown are expected */
    });
  }

  static async connect(url: string, token: string): Promise<WireClient> {
    const ws = new WsClient(`${url}/?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new WireClient(ws);
  }

  async request(request: ControlRequest, timeoutMs = 2000): Promise<ControlResponse> {
    const response = new Promise<ControlResponse>((resolve, reject) => {
      this.pending.set(request.id, resolve);
      setTimeout(() => {
        if (this.pending.delete(request.id)) {
          reject(new Error(`timed out awaiting a response to ${request.id}`));
        }
      }, timeoutMs).unref();
    });
    const envelope: Envelope = {
      stream: 'control',
      channel: 'control',
      seq: this.seq++,
      payload: request,
    };
    this.ws.send(JSON.stringify(envelope));
    return response;
  }

  close(): void {
    this.ws.close();
  }
}

let reqCounter = 0;
const nextId = (): string => `req_compose_${++reqCounter}`;

async function brokerHarness(runnerOptions: FakeQueryRunnerOptions = {}): Promise<{
  runner: FakeQueryRunner;
  broker: ComposedBroker;
  client: WireClient;
  done: () => Promise<void>;
}> {
  const runner = new FakeQueryRunner(runnerOptions);
  const broker = await composeBroker({
    storePath: ':memory:',
    profiles: { aibenderHome: '/synthetic/aibender-home' },
    runner,
    baseEnv: { PATH: '/usr/bin' },
    // No discovery file, and a synthetic home so log lines stay
    // identifier-free [X2] (nothing is written either way).
    gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home' },
  });
  const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
  return {
    runner,
    broker,
    client,
    done: async () => {
      client.close();
      await broker.close();
    },
  };
}

const LAUNCH_PARAMS = {
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'sdk',
  cwd: '/synthetic/workspace',
  purpose: 'synthesized composition demo',
  prompt: 'synthesized prompt',
} as const;

function okResult(response: ControlResponse): Extract<ControlResponse, { ok: true }>['result'] {
  if (!(response.ok === true)) {
    throw new Error(`expected ok response, got error ${JSON.stringify(response)}`);
  }
  return response.result;
}

function errDetail(response: ControlResponse): Extract<ControlResponse, { ok: false }>['error'] {
  if (response.ok) throw new Error('expected an error response');
  return response.error;
}

describe('composeBroker — WS → gateway → real kernel → real ledger (M1 demo wiring)', () => {
  // -- positive ------------------------------------------------------------

  it('drives launch · status · resume(fork) · kill end-to-end over the wire', async () => {
    const { runner, broker, client, done } = await brokerHarness({
      mode: 'manual',
      providePids: true,
    });
    try {
      // launch — the M1 composition awaits the spawn, so the projected
      // ledger state is `running` (ws-protocol §4.1 M1 note, ICR-0004).
      const launched = okResult(
        await client.request({ kind: 'launch', id: nextId(), params: LAUNCH_PARAMS }),
      );
      if (launched.verb !== 'launch') throw new Error('expected a launch result');
      expect(launched.state).toBe('running');
      const parentId = launched.sessionId;
      expect(broker.store.resumeLedger.get(parentId)?.state).toBe('running');
      expect(broker.store.resumeLedger.get(parentId)?.pid).toBe(40_000);

      // status (all sessions) — wire projection straight from the ledger.
      const statusAll = okResult(await client.request({ kind: 'status', id: nextId() }));
      if (statusAll.verb !== 'status') throw new Error('expected a status result');
      expect(statusAll.sessions).toHaveLength(1);
      expect(statusAll.sessions[0]).toMatchObject({
        sessionId: parentId,
        accountLabel: 'MAX_A',
        state: 'running',
        pid: 40_000,
      });

      // un-forked resume of the LIVE session → blueprint §5 guardrail,
      // mapped KernelError → KernelVerbError → wire error, code verbatim.
      const blocked = errDetail(
        await client.request({
          kind: 'resume',
          id: nextId(),
          params: { sessionId: parentId, prompt: 'synthesized continue' },
        }),
      );
      expect(blocked.code).toBe('double-resume-blocked');

      // Let the kernel pump ingest the init message (native id backfill).
      await new Promise((resolve) => setImmediate(resolve));

      // resume fork:true (+ prompt, ICR-0004) → continuation CHILD.
      const forked = okResult(
        await client.request({
          kind: 'resume',
          id: nextId(),
          params: { sessionId: parentId, fork: true, prompt: 'synthesized branch prompt' },
        }),
      );
      if (forked.verb !== 'resume') throw new Error('expected a resume result');
      expect(forked.forkedFrom).toBe(parentId);
      expect(forked.sessionId).not.toBe(parentId);
      const forkSpec = runner.starts.at(-1);
      expect(forkSpec?.forkSession).toBe(true);
      expect(forkSpec?.prompt).toBe('synthesized branch prompt');
      expect(forkSpec?.resumeNativeSessionId).toBe('fake-native-0');

      // kill both (graceful) — live sessions abort and settle at exited.
      for (const sessionId of [forked.sessionId, parentId]) {
        const killed = okResult(
          await client.request({ kind: 'kill', id: nextId(), params: { sessionId } }),
        );
        if (killed.verb !== 'kill') throw new Error('expected a kill result');
        expect(killed.state).toBe('exited');
        expect(broker.store.resumeLedger.get(sessionId)?.state).toBe('exited');
      }

      // kill of the already-settled parent is idempotent.
      const again = okResult(
        await client.request({ kind: 'kill', id: nextId(), params: { sessionId: parentId } }),
      );
      if (again.verb !== 'kill') throw new Error('expected a kill result');
      expect(again.state).toBe('exited');
    } finally {
      await done();
    }
  });

  it('un-forked dead resume of a previous broker life works over the wire (pid-null SDK shape)', async () => {
    const { broker, client, done } = await brokerHarness({ mode: 'manual' });
    try {
      // Fabricate a dead `running` row (pid NULL — the SDK path shape). The
      // default transcript locator resolves into the synthetic profile home,
      // which does not exist → validation skips (ENOENT), resume proceeds.
      const id = 'ses_dead_previous_life';
      broker.store.resumeLedger.insertBeforeSpawn({
        id,
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        cwd: '/synthetic/workspace',
        substrate: 'sdk',
        purpose: 'synthesized dead session',
      });
      broker.store.resumeLedger.transition(id, 'running');
      broker.store.resumeLedger.backfillNativeSessionId(id, 'synth-native-session');

      const resumed = okResult(
        await client.request({
          kind: 'resume',
          id: nextId(),
          params: { sessionId: id, prompt: 'synthesized dead-resume prompt' },
        }),
      );
      if (resumed.verb !== 'resume') throw new Error('expected a resume result');
      expect(resumed.sessionId).toBe(id); // SAME row — no fork
      expect(resumed.forkedFrom).toBeUndefined();
      expect(resumed.state).toBe('resumed');
      expect(broker.store.resumeLedger.get(id)?.state).toBe('resumed');
    } finally {
      await done();
    }
  });

  it('writes and removes the bootstrap discovery file when asked to advertise', async () => {
    const home = await mkdtemp(join(tmpdir(), 'aibender-broker-'));
    try {
      const broker = await composeBroker({
        storePath: ':memory:',
        profiles: { aibenderHome: '/synthetic/aibender-home' },
        runner: new FakeQueryRunner(),
        baseEnv: {},
        gateway: { aibenderHome: home },
      });
      const advertised = await readBootstrapFile({ aibenderHome: home });
      expect(advertised?.port).toBe(broker.gateway.port);
      expect(advertised?.token).toBe(broker.gateway.token);
      await broker.close();
      expect(await readBootstrapFile({ aibenderHome: home })).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // -- negative ------------------------------------------------------------

  it('resume without a prompt answers bad-request (ICR-0004 sdk-substrate rule)', async () => {
    const { client, done } = await brokerHarness();
    try {
      const detail = errDetail(
        await client.request({
          kind: 'resume',
          id: nextId(),
          params: { sessionId: 'ses_whatever' },
        }),
      );
      expect(detail.code).toBe('bad-request');
      expect(detail.message).toContain('prompt');
    } finally {
      await done();
    }
  });

  it('typed kernel refusals cross the adapter with their frozen codes', async () => {
    const { broker, client, done } = await brokerHarness();
    try {
      // unknown session: resume / kill / status all answer session-not-found.
      const resumeMissing = errDetail(
        await client.request({
          kind: 'resume',
          id: nextId(),
          params: { sessionId: 'ses_missing', prompt: 'x' },
        }),
      );
      expect(resumeMissing.code).toBe('session-not-found');
      const killMissing = errDetail(
        await client.request({ kind: 'kill', id: nextId(), params: { sessionId: 'ses_missing' } }),
      );
      expect(killMissing.code).toBe('session-not-found');
      const statusMissing = errDetail(
        await client.request({
          kind: 'status',
          id: nextId(),
          params: { sessionId: 'ses_missing' },
        }),
      );
      expect(statusMissing.code).toBe('session-not-found');

      // kill of a dead-but-unsettled row (previous broker life) is refused —
      // this broker cannot assert that child's fate at M1.
      const id = 'ses_dead_unsettled';
      broker.store.resumeLedger.insertBeforeSpawn({
        id,
        accountLabel: 'MAX_B',
        backend: 'claude_code',
        cwd: '/synthetic/workspace',
        substrate: 'sdk',
        purpose: 'synthesized unsettled row',
      });
      broker.store.resumeLedger.transition(id, 'running');
      const killDead = errDetail(
        await client.request({ kind: 'kill', id: nextId(), params: { sessionId: id } }),
      );
      expect(killDead.code).toBe('bad-request');
      expect(broker.store.resumeLedger.get(id)?.state).toBe('running'); // untouched
    } finally {
      await done();
    }
  });

  // -- edge ----------------------------------------------------------------

  it('broker close() shuts the gateway, drains the kernel, then closes the store', async () => {
    const { broker, client, done } = await brokerHarness({ mode: 'manual' });
    const launched = okResult(
      await client.request({ kind: 'launch', id: nextId(), params: LAUNCH_PARAMS }),
    );
    if (launched.verb !== 'launch') throw new Error('expected a launch result');
    expect(broker.kernel.isLive(launched.sessionId)).toBe(true);
    await done(); // close() aborts the live session, then closes sqlite
    // If the store had closed before the kernel drained, the pump's final
    // ledger transition would have thrown instead of settling the row.
    expect(broker.kernel.isLive(launched.sessionId)).toBe(false);
  });
});
