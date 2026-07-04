/**
 * M2 GATE integration: the approval round-trip END-TO-END over the real wire
 * (plan §9.3 BE↔FE #4; plan §8.2 M2 DoD "permission relay lands in the
 * approval inbox (hooks floor + canUseTool)").
 *
 * Unlike the per-lane suites (approvals.spec.ts drives the broker directly;
 * serverStreaming.spec.ts drives the gateway over a FakeApprovalBroker), this
 * suite composes the REAL pieces the way the M2 broker does and walks the
 * full chain over one WebSocket:
 *
 *   canUseTool escalation (per-session handler minted by the REAL kernel)
 *     → REAL ApprovalBroker queue
 *     → REAL gateway `approval-request` fan-out (the inbox feed)
 *     → client `approval-decision` envelope back over the SAME socket
 *     → broker resolution → `approval-resolved` fan-out
 *     → the awaiting canUseTool promise resolves → the session PROCEEDS
 *       to a normal exit.
 *
 * The SDK substrate is the testkit FakeQueryRunner in manual mode (the
 * ICR-0001 seam — the ONLY fake in the chain; a real `claude` child is T3
 * owner-gated). Launch itself also rides the wire (control-channel verb).
 *
 * [X2]: every fixture value is synthesized.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL,
  streamForChannel,
  validateEnvelope,
  type ChannelName,
  type Envelope,
} from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { FakeQueryRunner } from '@aibender/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { startGateway, type GatewayHandle } from '../gateway/index.js';
import {
  approvalRelayFromBroker,
  createApprovalBroker,
  createProfileRegistry,
  createSessionKernel,
  toApprovalBrokerGatewayPort,
  type ApprovalBroker,
  type SessionKernel,
} from '../kernel/index.js';
import { adaptSessionKernel } from './index.js';

// ---------------------------------------------------------------------------
// Minimal wire client (text envelopes only — no PTY traffic in this suite)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WireClient {
  readonly envelopes: Envelope[] = [];
  private readonly seqByChannel = new Map<ChannelName, number>();

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
    const seq = this.seqByChannel.get(channel) ?? 0;
    this.seqByChannel.set(channel, seq + 1);
    this.ws.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload }));
  }

  on(channel: ChannelName): Envelope[] {
    return this.envelopes.filter((envelope) => envelope.channel === channel);
  }

  /** Approvals-channel payloads of one kind, in arrival order. */
  approvals(kind: string): Record<string, unknown>[] {
    return this.on(CHANNEL.APPROVALS)
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

// ---------------------------------------------------------------------------
// Composition (the M2 broker shape: real kernel + real broker + real gateway)
// ---------------------------------------------------------------------------

let home: string;
let store: KernelStore;
let broker: ApprovalBroker;
let runner: FakeQueryRunner;
let kernel: SessionKernel;
let handle: GatewayHandle;
const clients: WireClient[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aibender-m2-approval-'));
  store = await openKernelStore({ path: ':memory:' });
  broker = createApprovalBroker({ defaultTtlMs: null });
  runner = new FakeQueryRunner({ mode: 'manual' });
  kernel = createSessionKernel({
    ledger: store.resumeLedger,
    profiles: createProfileRegistry({ aibenderHome: home }),
    runner,
    baseEnv: { PATH: '/usr/bin' },
    approvals: approvalRelayFromBroker(broker),
  });
  handle = await startGateway({
    kernel: adaptSessionKernel(kernel, store.resumeLedger),
    approvals: toApprovalBrokerGatewayPort(broker),
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await handle.close();
  broker.close();
  await kernel.shutdown();
  store.close();
  await rm(home, { recursive: true, force: true });
});

async function connect(): Promise<WireClient> {
  const client = await WireClient.connect(handle.url, handle.token);
  clients.push(client);
  return client;
}

/** Launch one synthetic SDK session over the control channel; return its id. */
async function launchOverTheWire(client: WireClient): Promise<string> {
  client.send(CHANNEL.CONTROL, {
    kind: 'launch',
    id: 'req_gate_01',
    params: {
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'm2 gate approval round-trip',
      prompt: 'synthesized gate prompt',
    },
  });
  await waitFor(
    () =>
      client
        .on(CHANNEL.CONTROL)
        .some((e) => isRecord(e.payload) && (e.payload as { id?: string }).id === 'req_gate_01'),
    'the launch response',
  );
  const response = client
    .on(CHANNEL.CONTROL)
    .map((e) => e.payload)
    .filter(isRecord)
    .find((p) => p['id'] === 'req_gate_01')!;
  expect(response['kind']).toBe('result');
  const result = response['result'] as { sessionId: string; state: string };
  expect(result.state).toBe('running');
  return result.sessionId;
}

// ---------------------------------------------------------------------------
// The round-trip
// ---------------------------------------------------------------------------

describe('M2 gate: canUseTool → inbox → decision → proceed (one socket, real chain)', () => {
  it('allow (with updatedInput) round-trips and the session proceeds to exit', async () => {
    const client = await connect();
    const sessionId = await launchOverTheWire(client);

    // The FAKE SDK asks permission — exactly what a real `claude` child does.
    const spec = runner.starts[0]!;
    expect(spec.canUseTool).toBeDefined();
    const pending = spec.canUseTool!('Bash', { command: 'ls' }, { toolUseId: 'tu_gate_1' });

    // 1. The escalation lands in the inbox feed over the wire.
    await waitFor(() => client.approvals('approval-request').length === 1, 'the inbox request');
    const request = client.approvals('approval-request')[0]!;
    expect(request).toMatchObject({
      source: 'can-use-tool',
      accountLabel: 'MAX_A',
      sessionId,
      toolName: 'Bash',
      toolUseId: 'tu_gate_1',
    });
    // [X2]: the summary is identifier-free (tool name only, never tool input).
    expect(request['summary']).toBe('tool escalation: Bash');

    // 2. The decision goes back over the SAME socket.
    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: request['approvalId'],
      verdict: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    // 3. The broker resolves; the resolution fans out; canUseTool unblocks.
    await waitFor(() => client.approvals('approval-resolved').length === 1, 'the resolution');
    expect(client.approvals('approval-resolved')[0]).toMatchObject({
      approvalId: request['approvalId'],
      outcome: 'allowed',
    });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    // 4. The session PROCEEDS: the (fake) SDK finishes its turn normally and
    //    the settled state is observable over the wire (status verb polls —
    //    the kernel drains its message stream asynchronously).
    runner.session(sessionId).complete();
    let poll = 0;
    const exitedOverTheWire = (): boolean =>
      client
        .on(CHANNEL.CONTROL)
        .map((e) => e.payload)
        .filter(isRecord)
        .some((p) => {
          if (typeof p['id'] !== 'string' || !p['id'].startsWith('req_gate_02')) return false;
          const result = p['result'] as
            | { sessions?: readonly { sessionId: string; state: string }[] }
            | undefined;
          return (
            result?.sessions?.some((s) => s.sessionId === sessionId && s.state === 'exited') ===
            true
          );
        });
    await waitFor(() => {
      if (!exitedOverTheWire()) {
        client.send(CHANNEL.CONTROL, { kind: 'status', id: `req_gate_02_${poll++}`, sessionId });
        return false;
      }
      return true;
    }, 'the exited status over the wire');
  });

  it('deny relays the note and the session survives (deny is not death)', async () => {
    const client = await connect();
    const sessionId = await launchOverTheWire(client);

    const pending = runner.starts[0]!.canUseTool!('Write', {}, { toolUseId: 'tu_gate_2' });
    await waitFor(() => client.approvals('approval-request').length === 1, 'the inbox request');

    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: client.approvals('approval-request')[0]!['approvalId'],
      verdict: 'deny',
      note: 'synthesized gate denial',
    });

    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'synthesized gate denial',
    });
    await waitFor(() => client.approvals('approval-resolved').length === 1, 'the resolution');
    expect(client.approvals('approval-resolved')[0]).toMatchObject({ outcome: 'denied' });

    // The session is still live and completes normally afterwards.
    expect(kernel.isLive(sessionId)).toBe(true);
    runner.session(sessionId).complete();
  });

  it('a second window converges: late joiner replays the request, loser gets not-pending', async () => {
    const first = await connect();
    const sessionId = await launchOverTheWire(first);

    const pending = runner.starts[0]!.canUseTool!('Bash', {}, { toolUseId: 'tu_gate_3' });
    await waitFor(() => first.approvals('approval-request').length === 1, 'the inbox request');

    // A second cockpit window connects AFTER the request: §8 replay delivers it.
    const second = await connect();
    second.send(CHANNEL.APPROVALS, { kind: 'replay-request', channel: 'approvals', fromSeq: 0 });
    await waitFor(() => second.approvals('approval-request').length === 1, 'the replayed request');
    const approvalId = second.approvals('approval-request')[0]!['approvalId'];

    // Both windows decide — the first wins, the second draws the NORMAL race answer.
    first.send(CHANNEL.APPROVALS, { kind: 'approval-decision', approvalId, verdict: 'allow' });
    await waitFor(() => first.approvals('approval-resolved').length === 1, 'the resolution');
    second.send(CHANNEL.APPROVALS, { kind: 'approval-decision', approvalId, verdict: 'deny' });
    await waitFor(
      () =>
        second
          .on(CHANNEL.CONTROL)
          .map((e) => e.payload)
          .filter(isRecord)
          .some((p) => p['kind'] === 'error' && p['code'] === 'approval-not-pending'),
      'the not-pending answer for the losing window',
    );

    // Both windows converged on the SAME terminal outcome.
    await waitFor(() => second.approvals('approval-resolved').length === 1, 'fan-out to window 2');
    expect(second.approvals('approval-resolved')[0]).toMatchObject({ outcome: 'allowed' });
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });

    runner.session(sessionId).complete();
  });
});
