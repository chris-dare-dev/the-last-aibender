/**
 * M4 [X4] composition integration (BE-7 narrow wiring into composeBroker —
 * the composedBroker.spec pattern extended to the workstream slice):
 *
 *   launch (control verb) → REAL kernel → REAL lineage recorder over the
 *     SAME kernel store → `workstream-node` fan-out on the frozen channel;
 *   merge request over the wire → BE-7 engine → atomic recordMerge →
 *     `workstream-merge-resolved` + node/edge/brief fan-out;
 *   FakeSession usage raw → ICR-0009 tee → context-pressure watch →
 *     `branch-advisory` on the wire;
 *   ptyHost recycle → ContinuationEdgeEmitter adapter → `continue` edge;
 *   BrokerPublishSinks carries the frozen resolver + hook routing (the
 *     graphfeed/hooks injection seam);
 *   boot pushes the §16.5 list snapshot into the replayable journal.
 *
 * [X2]: fixtures synthesized; placeholder labels only.
 */

import {
  CHANNEL,
  streamForChannel,
  validateEnvelope,
  type ChannelName,
  type Envelope,
} from '@aibender/protocol';
import { FakePtyBackend, FakeQueryRunner } from '@aibender/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { composeBroker, type BrokerPublishSinks, type ComposedBroker } from './index.js';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WireClient {
  readonly envelopes: Envelope[] = [];
  private seq = 0;

  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const validated = validateEnvelope(JSON.parse(String(data)));
      if (validated.ok) this.envelopes.push(validated.value);
    });
    ws.on('error', () => {
      /* closing races are expected */
    });
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

  send(channel: ChannelName, payload: unknown): void {
    this.ws.send(
      JSON.stringify({ stream: streamForChannel(channel), channel, seq: this.seq++, payload }),
    );
  }

  kind(kind: string): Record<string, unknown>[] {
    return this.envelopes
      .filter((envelope) => envelope.channel === CHANNEL.WORKSTREAM)
      .map((envelope) => envelope.payload)
      .filter(isRecord)
      .filter((payload) => payload['kind'] === kind);
  }

  close(): void {
    this.ws.close();
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Harness {
  readonly runner: FakeQueryRunner;
  readonly backend: FakePtyBackend;
  readonly broker: ComposedBroker;
  readonly client: WireClient;
  readonly sinks: BrokerPublishSinks[];
}

async function composedHarness(): Promise<Harness> {
  const runner = new FakeQueryRunner({ mode: 'manual' });
  const backend = new FakePtyBackend();
  const sinks: BrokerPublishSinks[] = [];
  const broker = await composeBroker({
    storePath: ':memory:',
    profiles: { aibenderHome: '/synthetic/aibender-home' },
    runner,
    baseEnv: { PATH: '/usr/bin' },
    logger: QUIET,
    gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    pty: { backend, logger: QUIET },
    approvals: { defaultTtlMs: null },
    workstreams: {
      logger: QUIET,
      // Low threshold + tiny window so a synthesized usage raw crosses it.
      pressure: { thresholdPct: 50, contextWindowTokens: 1000 },
    },
    publishers: [
      (published) => {
        sinks.push(published);
      },
    ],
  });
  cleanups.push(() => broker.close());
  const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
  cleanups.push(() => client.close());
  return { runner, backend, broker, client, sinks };
}

const LAUNCH = {
  kind: 'launch',
  id: 'req_ws_01',
  params: {
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate: 'sdk',
    cwd: '/synthetic/workspace',
    purpose: 'composed lineage exercise',
    prompt: 'synthesized prompt',
  },
} as const;

describe('composeBroker + workstreams (M4 [X4] slice)', () => {
  it('exposes the slice, pushes the §16.5 boot snapshot (replayable), and injects resolver + hooks into the sinks', async () => {
    const { broker, client, sinks } = await composedHarness();
    expect(broker.workstreams).toBeDefined();

    // The boot snapshot is journaled: replay from 0 finds it.
    client.send(CHANNEL.WORKSTREAM, {
      kind: 'replay-request',
      channel: CHANNEL.WORKSTREAM,
      fromSeq: 0,
    });
    await waitFor(
      () => client.kind('workstream-list-snapshot').length >= 1,
      'the boot list snapshot',
    );
    expect(client.kind('workstream-list-snapshot')[0]).toMatchObject({ detachedNodeCount: 0 });

    // The M4 injection seam (graphfeed / hooks lanes consume these).
    expect(sinks).toHaveLength(1);
    expect(typeof sinks[0]?.resolveSessionId).toBe('function');
    expect(sinks[0]?.workstreamHooks).toBe(broker.workstreams?.automation);
    // Unknown native ids relay verbatim (the frozen §15.2 rule).
    expect(sinks[0]?.resolveSessionId?.('native-unknown')).toBe('native-unknown');
  });

  it('a control-verb launch records its node over the SAME store and fans out workstream-node', async () => {
    const { runner, broker, client, sinks } = await composedHarness();

    client.send(CHANNEL.CONTROL, LAUNCH);
    await waitFor(() => client.kind('workstream-node').length >= 1, 'the launch node fan-out');

    const node = client.kind('workstream-node')[0];
    const sessionId = String(node?.['sessionId']);
    expect(node).toMatchObject({
      backend: 'claude_code',
      account: 'MAX_A',
      origin: 'harness',
      confidence: 'recorded',
      cwd: '/synthetic/workspace',
    });
    expect(broker.store.lineage.nodes.get(sessionId)).toBeDefined();
    // No native id ever rides this channel [X2].
    expect(JSON.stringify(node)).not.toContain('native');

    // The resolver now maps the fake runner's native id to the harness id.
    const fake = runner.session(sessionId);
    await waitFor(
      () => sinks[0]?.resolveSessionId?.(fake.nativeSessionId) === sessionId,
      'the resolver mapping after init backfill',
    );
    fake.complete();
  });

  it('the frozen merge verb lands end-to-end: ONE node, N merge_parent edges, resolved fan-out', async () => {
    const { runner, broker, client } = await composedHarness();

    // Two parents via real control-verb launches.
    client.send(CHANNEL.CONTROL, { ...LAUNCH, id: 'req_p1' });
    client.send(CHANNEL.CONTROL, { ...LAUNCH, id: 'req_p2' });
    await waitFor(() => client.kind('workstream-node').length >= 2, 'two parent nodes');
    const parents = client
      .kind('workstream-node')
      .map((node) => String(node['sessionId']))
      .slice(0, 2);
    for (const parent of parents) runner.session(parent).complete();

    client.send(CHANNEL.WORKSTREAM, {
      kind: 'workstream-merge-request',
      mergeId: 'mrg_composed_01',
      params: {
        parents,
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        cwd: '/synthetic/workspace',
        purpose: 'fuse the branches',
        briefBody: '## Merge brief\n\napproach: fused\n\n(conflicts surfaced upstream)',
      },
    });

    await waitFor(
      () => client.kind('workstream-merge-resolved').length === 1,
      'the merge resolution',
    );
    const resolved = client.kind('workstream-merge-resolved')[0];
    expect(resolved).toMatchObject({ mergeId: 'mrg_composed_01' });
    const mergeNodeId = String(resolved?.['sessionId']);
    const edges = broker.store.lineage.edges.list({ edgeTypes: ['merge_parent'] });
    expect(edges.map((edge) => edge.fromNode).sort()).toEqual([...parents].sort());
    expect(new Set(edges.map((edge) => edge.toNode))).toEqual(new Set([mergeNodeId]));
    // The brief + edges also fanned out on the wire.
    expect(client.kind('workstream-brief').length).toBeGreaterThanOrEqual(1);
    expect(client.kind('workstream-edge').length).toBeGreaterThanOrEqual(2);
  });

  it('the ICR-0009 tee feeds the pressure watch: usage above threshold fires ONE branch-advisory', async () => {
    const { runner, client } = await composedHarness();

    client.send(CHANNEL.CONTROL, LAUNCH);
    await waitFor(() => client.kind('workstream-node').length >= 1, 'the launch node');
    const sessionId = String(client.kind('workstream-node')[0]?.['sessionId']);

    // 600/1000 tokens = 60% > the composed 50% threshold.
    runner.session(sessionId).complete({
      raw: {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    });

    await waitFor(() => client.kind('branch-advisory').length >= 1, 'the branch advisory');
    const advisory = client.kind('branch-advisory')[0];
    expect(advisory).toMatchObject({ sessionId, contextUsedPct: 60 });
    // Fires ONCE (hysteresis) — no duplicate advisory arrived with it.
    expect(client.kind('branch-advisory')).toHaveLength(1);
  });

  it('a ptyHost recycle records the continue self-edge and announces the attended node', async () => {
    const { broker, client } = await composedHarness();
    const host = broker.ptyHost;
    if (host === undefined) throw new Error('pty slice must be composed');

    const session = await host.launchAttended({
      accountLabel: 'MAX_B',
      backend: 'claude_code',
      substrate: 'pty',
      cwd: '/synthetic/workspace',
      purpose: 'attended composed exercise',
    });
    await waitFor(
      () =>
        client
          .kind('workstream-node')
          .some((node) => node['sessionId'] === session.sessionId),
      'the attended launch node',
    );

    await host.recycle(session.sessionId);
    await waitFor(() => client.kind('workstream-edge').length >= 1, 'the recycle edge');
    expect(client.kind('workstream-edge')[0]).toMatchObject({
      fromSessionId: session.sessionId,
      toSessionId: session.sessionId,
      edgeType: 'continue',
      confidence: 'recorded',
    });
    const edges = broker.store.lineage.edges.list({ edgeTypes: ['continue'] });
    expect(edges).toHaveLength(1);
  });
});
