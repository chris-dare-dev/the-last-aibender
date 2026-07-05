/**
 * M5 [features 4/5] composition integration (BE-8 narrow wiring into
 * composeBroker — the composedWorkstreams.spec pattern extended to the
 * pipeline slice). The M5 DoD demo, over ONE composed broker:
 *
 *   pipeline-launch (wire verb) → BE-8 engine → 3 steps across
 *     MAX_A → AWS_DEV → LOCAL with an approval gate in the middle;
 *   the gate rides the EXISTING approvals channel (workflow-gate source);
 *   an approval-decision from the inbox resumes the walk;
 *   run/step status fans out on the frozen `pipelines` channel;
 *   step attempts land `session_node`s + `workflow` edges on the SAME kernel
 *     store, published on the `workstream` channel.
 *
 * Every step runs against a FakeStepExecutor (rule 3: no real spawn/cost).
 * [X2]: fixtures synthesized; placeholder labels only.
 */

import {
  CHANNEL,
  streamForChannel,
  validateEnvelope,
  type ChannelName,
  type DagDocument,
  type Envelope,
} from '@aibender/protocol';
import { FakeQueryRunner } from '@aibender/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { FakeStepExecutor } from '../pipelines/testSupport.js';
import { composeBroker, type ComposedBroker } from './index.js';

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
  send(channel: ChannelName, payload: unknown): void {
    this.ws.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq: this.seq++, payload }));
  }
  channelKind(channel: ChannelName, kind: string): Record<string, unknown>[] {
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

/** The M5 demo pipeline: MAX_A research → approval gate → AWS_DEV → LOCAL. */
const DEMO_PIPELINE: DagDocument = {
  schemaVersion: 1,
  id: 'wf_demo',
  name: 'cross-account demo',
  defaults: { account: 'MAX_A' },
  steps: [
    { kind: 'prompt', id: 'research', account: 'MAX_A', prompt: 'research the codebase' },
    { kind: 'approval', id: 'sign-off', needs: ['research'], summary: 'approve the plan' },
    { kind: 'prompt', id: 'bedrock', needs: ['sign-off'], account: 'AWS_DEV', backend: 'bedrock', prompt: 'implement' },
    { kind: 'prompt', id: 'summary', needs: ['bedrock'], account: 'LOCAL', prompt: 'summarize' },
  ],
};

async function composedHarness(): Promise<{ broker: ComposedBroker; client: WireClient; executor: FakeStepExecutor }> {
  const executor = new FakeStepExecutor({
    steps: {
      research: { costEstimatedUsd: 0.2, tokensIn: 100, tokensOut: 50 },
      bedrock: { costEstimatedUsd: 0.4, tokensIn: 200, tokensOut: 80 },
      summary: { costEstimatedUsd: 0, tokensIn: 50, tokensOut: 30 },
    },
  });
  const broker = await composeBroker({
    storePath: ':memory:',
    profiles: { aibenderHome: '/synthetic/aibender-home' },
    runner: new FakeQueryRunner({ mode: 'manual' }),
    baseEnv: { PATH: '/usr/bin' },
    logger: QUIET,
    gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    approvals: { defaultTtlMs: null }, // a gate may wait forever
    // The workstream slice must be composed for the lineage store's `workflow`
    // edges to fan out on the workstream channel.
    workstreams: { logger: QUIET },
    pipelines: { executor, nowMs: () => 1_700_000_000_000, sleep: () => Promise.resolve() },
  });
  cleanups.push(() => broker.close());
  const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
  cleanups.push(() => client.close());
  return { broker, client, executor };
}

describe('composed pipeline slice (M5, ICR-0012) — the DoD demo', () => {
  it('runs 3 steps across MAX_A → AWS_DEV → LOCAL with an approval gate, paused + resumed from the inbox', async () => {
    const { client, executor } = await composedHarness();

    // Launch the demo pipeline over the wire.
    client.send(CHANNEL.PIPELINES, {
      kind: 'pipeline-launch',
      requestId: 'req_launch',
      document: DEMO_PIPELINE,
    });

    // The run reaches the gate: `research` ran, `sign-off` is awaiting-approval,
    // and a workflow-gate approval-request fanned out on the approvals channel.
    await waitFor(
      () => client.channelKind(CHANNEL.APPROVALS, 'approval-request').length > 0,
      'the gate approval-request',
    );
    const gateReq = client.channelKind(CHANNEL.APPROVALS, 'approval-request')[0]!;
    expect(gateReq['source']).toBe('workflow-gate');
    expect(gateReq['runId']).toBeTruthy();
    expect(gateReq['stepId']).toBe('sign-off');
    // Downstream steps have NOT run yet (the walk is paused on the gate).
    expect(executor.calls.some((c) => c.stepId === 'bedrock')).toBe(false);
    // `research` ran on MAX_A.
    expect(executor.calls.find((c) => c.stepId === 'research')?.account).toBe('MAX_A');

    // Approve from the inbox → the walk resumes and finishes on LOCAL.
    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: gateReq['approvalId'],
      verdict: 'allow',
    });

    await waitFor(
      () =>
        client
          .channelKind(CHANNEL.PIPELINES, 'pipeline-run-status')
          .some((p) => p['state'] === 'completed'),
      'the run to complete',
    );

    // All three executable steps ran on their frozen accounts (the [X1] proof).
    const byStep = new Map(executor.calls.map((c) => [c.stepId, c]));
    expect(byStep.get('research')?.account).toBe('MAX_A');
    expect(byStep.get('bedrock')?.account).toBe('AWS_DEV');
    expect(byStep.get('bedrock')?.backend).toBe('bedrock');
    expect(byStep.get('summary')?.account).toBe('LOCAL');

    // Step statuses fanned out on the pipelines channel (incl. awaiting-approval).
    const stepStates = client.channelKind(CHANNEL.PIPELINES, 'pipeline-step-status');
    expect(stepStates.some((p) => p['state'] === 'awaiting-approval')).toBe(true);
    expect(stepStates.some((p) => p['stepId'] === 'summary' && p['state'] === 'completed')).toBe(true);

    // Lineage: `workflow` edges fanned out on the workstream channel (each step
    // attempt = a session_node; edges connect them).
    const nodes = client.channelKind(CHANNEL.WORKSTREAM, 'workstream-node');
    const edges = client.channelKind(CHANNEL.WORKSTREAM, 'workstream-edge');
    expect(nodes.length).toBeGreaterThanOrEqual(3); // research, bedrock, summary
    expect(edges.some((e) => e['edgeType'] === 'workflow')).toBe(true);
  });

  it('with no pipelines slice composed, pipeline verbs degrade to pipeline-not-found', async () => {
    const broker = await composeBroker({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      runner: new FakeQueryRunner({ mode: 'manual' }),
      logger: QUIET,
      gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    });
    cleanups.push(() => broker.close());
    const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
    cleanups.push(() => client.close());

    client.send(CHANNEL.PIPELINES, { kind: 'pipeline-launch', requestId: 'req_x', document: DEMO_PIPELINE });
    await waitFor(
      () =>
        client.envelopes.some(
          (e) => isRecord(e.payload) && e.payload['kind'] === 'error' && e.payload['code'] === 'pipeline-not-found',
        ),
      'the empty-broker degrade',
    );
  });
});
