/**
 * M6 [X1] BE-9 composition integration (supervision slice narrow wiring into
 * composeBroker — the composedWorkstreams.spec pattern extended to the
 * supervision slice). Over ONE composed broker + ONE real WS socket:
 *
 *   - the governor's resource-health snapshot rides the EVENTS channel as the
 *     eleventh read model (frozen M6), reaching a real client;
 *   - a watchdog-triggered RECYCLE runs through the COMPOSED ptyHost
 *     (checkpoint→kill→resume) and records its `continue` edge on the SAME
 *     lineage store as an operator recycle — proving lineage continuity across
 *     a supervision recycle END-TO-END (the M6 DoD "one real recycle with
 *     lineage continuity");
 *   - the [X1] account-spawn-post-shed admission is honored at the composed
 *     governor.
 *
 * The telemetry ports are FAKES (no real process bloat, no memory_pressure
 * shell). [X2]: synthesized labels only; the snapshot carries no session id.
 */

import {
  CHANNEL,
  validateEnvelope,
  type ChannelName,
  type Envelope,
} from '@aibender/protocol';
import { FakePtyBackend, FakeQueryRunner } from '@aibender/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import type { FootprintSampler, PressureProbe, PressureReading, SupervisedSession } from '../supervision/index.js';
import { composeBroker, type ComposedBroker } from './index.js';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WireClient {
  readonly envelopes: Envelope[] = [];
  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const validated = validateEnvelope(JSON.parse(String(data)));
      if (validated.ok) this.envelopes.push(validated.value);
    });
    ws.on('error', () => {});
  }
  static async connect(url: string, token: string): Promise<WireClient> {
    const ws = new WsClient(`${url}/?token=${token}`);
    const client = new WireClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }
  channelKindReadModel(channel: ChannelName, readModel: string): Record<string, unknown>[] {
    return this.envelopes
      .filter((e) => e.channel === channel)
      .map((e) => e.payload)
      .filter(isRecord)
      .filter((p) => p['kind'] === 'read-model-snapshot' && p['readModel'] === readModel);
  }
  kind(channel: ChannelName, kind: string): Record<string, unknown>[] {
    return this.envelopes
      .filter((e) => e.channel === channel)
      .map((e) => e.payload)
      .filter(isRecord)
      .filter((p) => p['kind'] === kind);
  }
  close(): void {
    this.ws.close();
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const calm: PressureReading = { pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 0 };

/** A mutable fake sampler: the test sets footprints by session id. */
function mutableSampler(byId: Map<string, number>): FootprintSampler {
  return { sampleMb: (s: SupervisedSession) => byId.get(s.sessionId) };
}

interface Harness {
  readonly broker: ComposedBroker;
  readonly client: WireClient;
  readonly footprints: Map<string, number>;
  readonly pressure: { current: PressureReading | undefined };
}

async function composedHarness(): Promise<Harness> {
  const footprints = new Map<string, number>();
  const pressure: { current: PressureReading | undefined } = { current: calm };
  const sampler = mutableSampler(footprints);
  const probe: PressureProbe = { read: () => pressure.current };
  const broker = await composeBroker({
    storePath: ':memory:',
    profiles: { aibenderHome: '/synthetic/aibender-home' },
    runner: new FakeQueryRunner({ mode: 'manual' }),
    baseEnv: { PATH: '/usr/bin', HOME: '/synthetic/aibender-home' },
    logger: QUIET,
    gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    pty: { backend: new FakePtyBackend(), logger: QUIET, forceKillAfterMs: 200 },
    approvals: { defaultTtlMs: null },
    workstreams: { logger: QUIET },
    supervision: { sampler, probe, logger: QUIET },
  });
  cleanups.push(() => broker.close());
  const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
  cleanups.push(() => client.close());
  return { broker, client, footprints, pressure };
}

describe('composeBroker + supervision (M6 [X1] BE-9 slice)', () => {
  it('exposes the composed supervision slice', async () => {
    const { broker } = await composedHarness();
    expect(broker.supervision).toBeDefined();
    expect(broker.supervision?.governor).toBeDefined();
  });

  it('the governor resource-health snapshot rides the EVENTS channel to a real client', async () => {
    const { broker, client } = await composedHarness();
    await broker.supervision!.tickAndPublish(90_100_000);
    await waitFor(
      () => client.channelKindReadModel(CHANNEL.EVENTS, 'resource-health').length >= 1,
      'the resource-health snapshot on the events channel',
    );
    const snapshot = client.channelKindReadModel(CHANNEL.EVENTS, 'resource-health')[0]!;
    expect(snapshot['readModel']).toBe('resource-health');
    // [X2]: labels + numbers only — no session id / cwd on the wire.
    expect(JSON.stringify(snapshot)).not.toContain('/synthetic/aibender-home');
  });

  it('a watchdog RECYCLE runs the composed ptyHost and records a continue edge (lineage continuity E2E)', async () => {
    const { broker, client, footprints } = await composedHarness();
    const host = broker.ptyHost!;

    // Launch an attended claude session (row-before-spawn + lineage node +
    // the launch node published on the workstream channel).
    const session = await host.launchAttended({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'pty',
      cwd: '/synthetic/workspace',
      purpose: 'composed supervision recycle',
    });
    await waitFor(() => client.kind(CHANNEL.WORKSTREAM, 'workstream-node').length >= 1, 'the launch node');

    // Register the session with the governor + induce "bloat" over the claude
    // 6 GB recycle line (a FAKE sampler value — NO real process is bloated).
    broker.supervision!.governor.register({
      sessionId: session.sessionId,
      account: 'MAX_A',
      backend: 'claude_code',
      watchdogClass: 'claude',
      slot: 0,
      isAccountSession: true,
    });
    footprints.set(session.sessionId, 6656);

    // One governor tick: watchdog bands `recycle` → ptyHost recycle → the
    // [X4] continue edge lands on the SAME lineage store (published on the
    // workstream channel), and the resource-health snapshot rides events.
    const result = await broker.supervision!.tickAndPublish(90_100_480);
    expect(result.recycled).toEqual([session.sessionId]);

    await waitFor(
      () => client.kind(CHANNEL.WORKSTREAM, 'workstream-edge').length >= 1,
      'the recycle continue edge',
    );
    const edges = broker.store.lineage.edges.list();
    const recycleEdge = edges.find((e) => e.toNode === session.sessionId && e.edgeType === 'continue');
    expect(recycleEdge).toBeDefined();
    expect(JSON.parse(recycleEdge?.metadataJson ?? '{}')).toMatchObject({ reason: 'recycle' });
    // Continuity: the node survives the recycle.
    expect(broker.store.lineage.nodes.get(session.sessionId)).toBeDefined();
  });

  it('[X1] a red-pressure account spawn is admitted post-shed at the composed governor', async () => {
    const { broker, pressure } = await composedHarness();
    pressure.current = { pressureLevel: 4, freeRamPct: 8, swapUsedBytes: 28e9, pageoutRate: 3000 };
    await broker.supervision!.tickAndPublish(1);
    expect(broker.supervision!.governor.pressureState()).toBe('red');
    expect(broker.supervision!.governor.admitSpawnNow(true).admit).toBe(true); // account
    expect(broker.supervision!.governor.admitSpawnNow(false)).toEqual({
      admit: false,
      reason: 'red-pressure-non-account',
    });
  });

  it('absent supervision option → M1–M5 behavior exactly (no slice)', async () => {
    const broker = await composeBroker({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      runner: new FakeQueryRunner({ mode: 'manual' }),
      baseEnv: { PATH: '/usr/bin' },
      logger: QUIET,
      gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    });
    cleanups.push(() => broker.close());
    expect(broker.supervision).toBeUndefined();
  });
});
