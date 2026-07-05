/**
 * M3 composition integration: EVERY gateway port through ONE composeBroker,
 * proven over one real WebSocket (BE-MAIN; resolves M2 deviation D3,
 * docs/runbooks/m2-dod.md §4, and deferred watch item 1,
 * docs/contracts/icr/README.md).
 *
 * This is the m2ApprovalRoundTrip pattern promoted INTO the composition root:
 * where that suite hand-composed kernel + broker + gateway the way `main`
 * would, this suite calls {@link composeBroker} itself and walks the whole
 * M2/M3 surface over a single socket:
 *
 *   launch (control verb)                      → REAL kernel over the testkit
 *                                                FakeQueryRunner (the ONLY
 *                                                fake in the SDK chain)
 *   attended PTY (host.launchAttended)         → REAL ptyHost over testkit's
 *                                                FakePtyBackend (the pixels
 *                                                fake — ICR-0006)
 *   canUseTool escalation → decision → proceed → REAL ApprovalBroker, both
 *                                                halves composed here
 *   SDK messages → transcript.<sid> fan-out    → the ICR-0009 kernel tap teed
 *                                                onto the gateway projector
 *   M3 publisher lanes                         → BrokerPublisherStarter stubs
 *                                                over the frozen-typed sinks
 *                                                (BE-5/BE-6 land on this seam)
 *
 * [X2]: every fixture value is synthesized (placeholder labels, ses_fake/
 * synthetic paths, obviously-fake bytes).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL,
  decodePtyFrame,
  encodePtyFrame,
  ptyChannel,
  streamForChannel,
  transcriptChannel,
  validateEnvelope,
  type ChannelName,
  type Envelope,
  type EventSummary,
  type QuotaSnapshot,
} from '@aibender/protocol';
import { openEventsStore, type EventsStore } from '@aibender/schema';
import { FakePtyBackend, FakeQueryRunner } from '@aibender/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import {
  composeBroker,
  type BrokerPublisherStarter,
  type BrokerPublishSinks,
  type ComposedBroker,
} from './index.js';
import { HOOK_TOKEN_HEADER } from '../collector/hooks/index.js';
import type { RunnerMessageTap } from '../kernel/index.js';

// ---------------------------------------------------------------------------
// Wire client (text envelopes + binary PTY frames on the SAME socket)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WireClient {
  readonly envelopes: Envelope[] = [];
  /** Reassembled OUTPUT bytes per pty session (contiguous offsets enforced). */
  readonly ptyBytes = new Map<string, number[]>();
  readonly problems: string[] = [];
  private readonly seqByChannel = new Map<ChannelName, number>();

  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = data as Buffer;
        const decoded = decodePtyFrame(
          new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        );
        if (!decoded.ok) {
          this.problems.push(`binary frame failed the frozen codec: ${decoded.message}`);
          return;
        }
        const got = this.ptyBytes.get(decoded.value.sessionId) ?? [];
        if (decoded.value.streamOffset !== got.length) {
          this.problems.push(
            `non-contiguous pty stream: expected ${got.length}, got ${decoded.value.streamOffset}`,
          );
          return;
        }
        got.push(...decoded.value.payload);
        this.ptyBytes.set(decoded.value.sessionId, got);
        return;
      }
      const validated = validateEnvelope(JSON.parse(String(data)));
      if (validated.ok) this.envelopes.push(validated.value);
      else this.problems.push(`bad envelope: ${validated.message}`);
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

  sendPtyInput(sessionId: string, payload: Uint8Array): void {
    this.ws.send(encodePtyFrame({ type: 'input', sessionId, streamOffset: 0, payload }), {
      binary: true,
    });
  }

  on(channel: ChannelName): Record<string, unknown>[] {
    return this.envelopes
      .filter((envelope) => envelope.channel === channel)
      .map((envelope) => envelope.payload)
      .filter(isRecord);
  }

  kind(channel: ChannelName, kind: string): Record<string, unknown>[] {
    return this.on(channel).filter((payload) => payload['kind'] === kind);
  }

  ptyText(sessionId: string): string {
    return new TextDecoder().decode(Uint8Array.from(this.ptyBytes.get(sessionId) ?? []));
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
// Harness — ONE composeBroker call, everything else is the frozen wire
// ---------------------------------------------------------------------------

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Harness {
  readonly runner: FakeQueryRunner;
  readonly backend: FakePtyBackend;
  readonly broker: ComposedBroker;
  readonly client: WireClient;
  /** Idempotent broker close — tests that need explicit ordering call it. */
  close(): Promise<void>;
}

async function composedHarness(
  extra: {
    readonly publishers?: readonly BrokerPublisherStarter[];
    readonly messageTap?: RunnerMessageTap;
  } = {},
): Promise<Harness> {
  const runner = new FakeQueryRunner({ mode: 'manual' });
  const backend = new FakePtyBackend();
  const broker = await composeBroker({
    storePath: ':memory:',
    profiles: { aibenderHome: '/synthetic/aibender-home' },
    runner,
    baseEnv: { PATH: '/usr/bin' },
    logger: QUIET,
    gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    pty: { backend, logger: QUIET },
    approvals: { defaultTtlMs: null },
    ...(extra.publishers !== undefined ? { publishers: extra.publishers } : {}),
    ...(extra.messageTap !== undefined ? { messageTap: extra.messageTap } : {}),
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await broker.close();
  };
  cleanups.push(close);
  const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
  cleanups.push(() => client.close());
  return { runner, backend, broker, client, close };
}

/** Launch one synthetic SDK session over the control channel; return its id. */
async function launchOverTheWire(client: WireClient, id: string): Promise<string> {
  client.send(CHANNEL.CONTROL, {
    kind: 'launch',
    id,
    params: {
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'm3 composed-broker gate',
      prompt: 'synthesized gate prompt',
    },
  });
  await waitFor(
    () => client.on(CHANNEL.CONTROL).some((p) => p['id'] === id && p['kind'] === 'result'),
    'the launch response',
  );
  const response = client.on(CHANNEL.CONTROL).find((p) => p['id'] === id)!;
  const result = response['result'] as { sessionId: string; state: string };
  expect(result.state).toBe('running');
  return result.sessionId;
}

// ---------------------------------------------------------------------------
// The composed gate flow
// ---------------------------------------------------------------------------

describe('composeBroker — M2/M3 ports through ONE composition, one socket', () => {
  // -- positive: the whole flow ---------------------------------------------

  it('launch → attended pty → approval → transcript all flow through the one composed broker', async () => {
    const { runner, backend, broker, client } = await composedHarness();

    // 1. LAUNCH — control verb over the wire into the REAL kernel.
    const sdkSessionId = await launchOverTheWire(client, 'req_m3_launch');

    // 2. ATTENDED PTY — host-side launch (attended sessions have no control
    //    verb; the wire carries their bytes), announced through the composed
    //    pty port, attached over the SAME socket.
    const attended = await broker.ptyHost!.launchAttended({
      accountLabel: 'MAX_B',
      backend: 'claude_code',
      substrate: 'pty',
      cwd: '/synthetic/workspace',
      purpose: 'm3 composed attended session',
    });
    const proc = backend.latest();
    proc.emitText('SYNTHETIC-TUI ready [X2]\r\n');
    client.send(ptyChannel(attended.sessionId) as ChannelName, {
      kind: 'pty-replay-request',
      sessionId: attended.sessionId,
      fromWatermark: 0,
    });
    await waitFor(
      () => client.ptyText(attended.sessionId).includes('SYNTHETIC-TUI ready'),
      'the attended banner over the wire',
    );
    client.sendPtyInput(attended.sessionId, new TextEncoder().encode('k'));
    await waitFor(() => proc.writes.length === 1, 'the keystroke to reach the child');
    expect(new TextDecoder().decode(proc.writes[0])).toBe('k');

    // 3. APPROVAL — the (fake) SDK escalates exactly like a real child; the
    //    inbox request and the decision ride the SAME socket.
    const pending = runner.starts[0]!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { toolUseId: 'tu_m3_1' },
    );
    await waitFor(
      () => client.kind(CHANNEL.APPROVALS, 'approval-request').length === 1,
      'the inbox request',
    );
    const request = client.kind(CHANNEL.APPROVALS, 'approval-request')[0]!;
    expect(request).toMatchObject({
      source: 'can-use-tool',
      accountLabel: 'MAX_A',
      sessionId: sdkSessionId,
      toolName: 'Bash',
    });
    // [X2]: identifier-free summary — tool name only, never tool input.
    expect(request['summary']).toBe('tool escalation: Bash');
    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: request['approvalId'],
      verdict: 'allow',
    });
    await waitFor(
      () => client.kind(CHANNEL.APPROVALS, 'approval-resolved').length === 1,
      'the resolution fan-out',
    );
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' }, // plain allow echoes the original input
    });

    // 4. TRANSCRIPT — SDK messages tee through the ICR-0009 tap onto the
    //    gateway projector; the frozen transcript.<sid> payloads arrive on
    //    the SAME socket.
    const channel = transcriptChannel(sdkSessionId) as ChannelName;
    runner.session(sdkSessionId).emit({
      type: 'other',
      raw: {
        type: 'assistant',
        uuid: 'uuid_fake_m3_1',
        message: { content: [{ type: 'text', text: 'synthesized reply' }] },
      },
    });
    await waitFor(() => client.kind(channel, 'transcript-delta').length === 1, 'the delta');
    expect(client.kind(channel, 'transcript-delta')[0]).toMatchObject({
      sessionId: sdkSessionId,
      messageUuid: 'uuid_fake_m3_1',
      text: 'synthesized reply',
    });
    runner.session(sdkSessionId).complete({
      raw: {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
        },
        total_cost_usd: 0.012,
        duration_ms: 900,
      },
    });
    await waitFor(() => client.kind(channel, 'transcript-result').length === 1, 'the result');
    expect(client.kind(channel, 'transcript-result')[0]).toMatchObject({
      sessionId: sdkSessionId,
      ok: true,
      detail: 'success',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheCreationTokens: 20 },
      costUsd: 0.012,
      durationMs: 900,
    });

    // The SDK session settles in the ledger; the attended child is still live
    // (its shutdown belongs to broker.close()); nothing on the wire broke.
    await waitFor(
      () => broker.store.resumeLedger.get(sdkSessionId)?.state === 'exited',
      'the sdk session to settle',
    );
    expect(broker.ptyHost!.live()).toContain(attended.sessionId);
    expect(client.problems).toEqual([]);
  });

  // -- positive: M3 publisher lanes ------------------------------------------

  it('publisher lanes get the frozen-typed sinks; payloads reach the wire; close ordering flushes', async () => {
    const capturedAt = 90_100_000;
    const flushSnapshot: QuotaSnapshot = {
      kind: 'quota-snapshot',
      account: 'MAX_B',
      window: '7d',
      usedPct: 88,
      resetsAt: capturedAt + 1000,
      capturedAt,
      source: 'oauth-poll',
    };
    let closedLanes = 0;
    const lane: BrokerPublisherStarter = (sinks) => {
      sinks.publishQuota({
        kind: 'quota-snapshot',
        account: 'MAX_A',
        window: '5h',
        usedPct: 41.5,
        resetsAt: capturedAt + 100_000,
        capturedAt,
        source: 'statusline',
      });
      sinks.publishContextTouch({
        kind: 'context-touch',
        sessionId: 'ses_fake_1',
        path: '/synthetic/workspace/src/main.ts',
        relation: 'read',
        ts: capturedAt,
      });
      sinks.publishEvent({
        kind: 'event-summary',
        eventId: 1,
        ts: capturedAt,
        account: 'MAX_A',
        backend: 'claude_code',
        source: 'claude-jsonl',
        eventType: 'assistant-turn',
      });
      return {
        close: () => {
          closedLanes += 1;
          // Publishers close BEFORE the gateway: this final flush must still
          // reach connected clients (a closed gateway drops broadcasts
          // silently — the arrival assertion below would then time out).
          sinks.publishQuota(flushSnapshot);
        },
      };
    };

    const harness = await composedHarness({ publishers: [lane] });
    const { client } = harness;
    // The lane published at COMPOSE time (before this client connected): the
    // journaled frames are recovered through the frozen §8 replay path — also
    // proving the composed broker journals its M3 fan-out channels.
    for (const channel of [CHANNEL.QUOTA, CHANNEL.CONTEXT_GRAPH, CHANNEL.EVENTS]) {
      client.send(channel, { kind: 'replay-request', channel, fromSeq: 0 });
    }
    await waitFor(
      () =>
        client.kind(CHANNEL.QUOTA, 'quota-snapshot').length === 1 &&
        client.kind(CHANNEL.CONTEXT_GRAPH, 'context-touch').length === 1 &&
        client.kind(CHANNEL.EVENTS, 'event-summary').length === 1,
      'the three fan-out payloads (replayed)',
    );
    expect(client.kind(CHANNEL.QUOTA, 'quota-snapshot')[0]).toMatchObject({
      account: 'MAX_A',
      window: '5h',
      usedPct: 41.5,
    });
    expect(client.kind(CHANNEL.EVENTS, 'event-summary')[0]).toMatchObject({
      eventId: 1,
      source: 'claude-jsonl',
      eventType: 'assistant-turn',
    });

    // Close the broker while the CLIENT is still connected: the lane closes
    // exactly once, and its flush beat the gateway teardown to the wire.
    await harness.close();
    expect(closedLanes).toBe(1);
    await waitFor(
      () => client.kind(CHANNEL.QUOTA, 'quota-snapshot').length === 2,
      'the close-ordering flush snapshot',
    );
    expect(client.kind(CHANNEL.QUOTA, 'quota-snapshot')[1]).toMatchObject({
      account: 'MAX_B',
      window: '7d',
      usedPct: 88,
    });
  });

  // -- negative ---------------------------------------------------------------

  it('the events sink refuses an invalid event-summary with a RangeError (never wire traffic)', async () => {
    let sinks: BrokerPublishSinks | undefined;
    const { client } = await composedHarness({
      publishers: [
        (s) => {
          sinks = s;
        },
      ],
    });
    expect(() => sinks!.publishEvent({ kind: 'event-summary' } as EventSummary)).toThrowError(
      RangeError,
    );
    // Nothing was broadcast or journaled for the refused payload.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.on(CHANNEL.EVENTS)).toHaveLength(0);
  });

  it('composeBroker refuses a caller-supplied approvalRelay (both halves must share ITS broker)', async () => {
    await expect(
      composeBroker({
        storePath: ':memory:',
        profiles: { aibenderHome: '/synthetic/aibender-home' },
        runner: new FakeQueryRunner(),
        baseEnv: {},
        gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home' },
        approvalRelay: {
          canUseToolFor: () => async () => ({ behavior: 'deny', message: 'synthesized' }),
          sessionEnded: () => {},
        },
      }),
    ).rejects.toThrow(/composeBroker owns the approval relay/);
  });

  it('a publisher lane that fails to start does not leak the broker (started lanes closed)', async () => {
    let firstClosed = 0;
    await expect(
      composeBroker({
        storePath: ':memory:',
        profiles: { aibenderHome: '/synthetic/aibender-home' },
        runner: new FakeQueryRunner(),
        baseEnv: {},
        logger: QUIET,
        gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
        publishers: [
          () => ({
            close: () => {
              firstClosed += 1;
            },
          }),
          () => {
            throw new Error('synthesized publisher boot failure');
          },
        ],
      }),
    ).rejects.toThrow('synthesized publisher boot failure');
    expect(firstClosed).toBe(1);
  });

  // -- edge ---------------------------------------------------------------------

  it('unknown events kinds pass the sink (frozen forward-tolerant rule) and ride opaquely', async () => {
    let sinks: BrokerPublishSinks | undefined;
    const { client } = await composedHarness({
      publishers: [
        (s) => {
          sinks = s;
        },
      ],
    });
    sinks!.publishEvent({ kind: 'synthesized-draft-event' } as unknown as EventSummary);
    await waitFor(
      () => client.on(CHANNEL.EVENTS).some((p) => p['kind'] === 'synthesized-draft-event'),
      'the opaque payload',
    );
  });

  it('a caller messageTap composes with the transcript tee (both observe every message)', async () => {
    const tapped: Array<{ sessionId: string; type: string }> = [];
    const { runner, client } = await composedHarness({
      messageTap: (sessionId, message) => tapped.push({ sessionId, type: message.type }),
    });
    const sessionId = await launchOverTheWire(client, 'req_m3_tap');
    runner.session(sessionId).complete();
    const channel = transcriptChannel(sessionId) as ChannelName;
    await waitFor(() => client.kind(channel, 'transcript-result').length === 1, 'the tee output');
    // The user tap saw the SAME stream the tee projected from.
    expect(tapped).toEqual([
      { sessionId, type: 'init' },
      { sessionId, type: 'result' },
    ]);
  });

  it('without pty options the composed broker has no ptyHost and control verbs still serve', async () => {
    const runner = new FakeQueryRunner({ mode: 'manual' });
    const broker = await composeBroker({
      storePath: ':memory:',
      profiles: { aibenderHome: '/synthetic/aibender-home' },
      runner,
      baseEnv: {},
      logger: QUIET,
      gateway: { writeBootstrap: false, aibenderHome: '/synthetic/aibender-home', logger: QUIET },
    });
    cleanups.push(() => broker.close());
    expect(broker.ptyHost).toBeUndefined();
    const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
    cleanups.push(() => client.close());
    const sessionId = await launchOverTheWire(client, 'req_m3_nopty');
    expect(broker.kernel.isLive(sessionId)).toBe(true);
    runner.session(sessionId).complete();
  });

  it('close() supersedes pending approvals through kernel drain (relay still wired at shutdown)', async () => {
    const harness = await composedHarness();
    const { runner, broker, client } = harness;
    const sessionId = await launchOverTheWire(client, 'req_m3_shutdown');
    const pending = runner.starts[0]!.canUseTool!('Write', {}, { toolUseId: 'tu_m3_2' });
    await waitFor(
      () => client.kind(CHANNEL.APPROVALS, 'approval-request').length === 1,
      'the inbox request',
    );
    await harness.close(); // publishers → gateway → pty → kernel drain → approvals
    // The abort path ends the session; the composed relay superseded its wait
    // (deny-shaped interrupt) rather than parking it forever.
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(broker.kernel.isLive(sessionId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEC-3 — the per-install hooks-endpoint token, READ at boot and enforced
// (hooks-contract.md §4.2, ICR-0015; BE-MAIN follow-up #1). The broker READS
// $AIBENDER_HOME/hook-token (SI-3 mints it; presence = opt-in) and passes it as
// startHooksServer's authToken — proven end-to-end over the REAL loopback HTTP
// endpoint composed by composeBroker.
// ---------------------------------------------------------------------------

describe('composeBroker — SEC-3 hooks-endpoint token gate', () => {
  // A synthetic per-install token in the gateway-token shape (base64url-ish).
  // [X2]: obviously fake, never a real secret.
  const HOOK_TOKEN = 'synthesized-per-install-hook-token-000000000';
  const HOOK_BODY = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'synth-native-hooks',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_output: { ok: true },
  });

  const postHook = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${url}/hooks/v1/MAX_A`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: HOOK_BODY,
    });

  /**
   * Compose a broker whose $AIBENDER_HOME is a fresh tmp dir; when `token` is
   * given it is written to `<home>/hook-token` (0600, with a trailing newline
   * exactly like SI-3's `printf '%s\n'`) BEFORE composition so the boot-time
   * read sees it. The collector events store is the separate §6.2 database the
   * operator config surface hands in.
   */
  async function composeHooksBroker(
    token?: string,
  ): Promise<{ broker: ComposedBroker; events: EventsStore }> {
    const home = mkdtempSync(join(tmpdir(), 'aib-hooks-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    if (token !== undefined) {
      writeFileSync(join(home, 'hook-token'), `${token}\n`, { mode: 0o600 });
    }
    const events = await openEventsStore({ path: ':memory:' });
    cleanups.push(() => events.close());
    const broker = await composeBroker({
      storePath: ':memory:',
      profiles: { aibenderHome: home },
      runner: new FakeQueryRunner({ mode: 'manual' }),
      baseEnv: {},
      logger: QUIET,
      gateway: { writeBootstrap: false, aibenderHome: home, logger: QUIET },
      hooks: { events: events.events, port: 0 },
    });
    cleanups.push(() => broker.close());
    return { broker, events };
  }

  it('token file present → 401s a token-less POST and accepts the correctly-headed one', async () => {
    const { broker, events } = await composeHooksBroker(HOOK_TOKEN);
    const url = broker.hooks!.url;
    expect(url.startsWith('http://127.0.0.1:')).toBe(true); // loopback preserved

    // No header → 401 BEFORE any parse/insert (the store stays empty).
    expect((await postHook(url)).status).toBe(401);
    expect(events.events.list()).toHaveLength(0);

    // Wrong token → 401, still nothing inserted.
    expect((await postHook(url, { [HOOK_TOKEN_HEADER]: `${HOOK_TOKEN}-x` })).status).toBe(401);
    expect(events.events.list()).toHaveLength(0);

    // The EXACT trimmed file contents → 204 accepted + one row. That the value
    // WITHOUT the trailing newline is accepted proves the broker passed the
    // TRIMMED token as authToken (an untrimmed authToken would 401 here).
    expect((await postHook(url, { [HOOK_TOKEN_HEADER]: HOOK_TOKEN })).status).toBe(204);
    expect(events.events.list()).toHaveLength(1);
    expect(broker.hooks!.stats().rejected401).toBe(2);
    expect(broker.hooks!.stats().accepted).toBe(1);
  });

  it('token file absent → authToken undefined; the endpoint keeps the open posture', async () => {
    const { broker, events } = await composeHooksBroker(); // no token file written
    const url = broker.hooks!.url;
    // A header-less POST is accepted — byte-compatible with the M2–M6 open
    // loopback posture (presence of the file is the operator opt-in).
    expect((await postHook(url)).status).toBe(204);
    expect(events.events.list()).toHaveLength(1);
    expect(broker.hooks!.stats().rejected401).toBe(0);
  });

  it('the hooks token is DISTINCT from the per-boot WS gateway token (no cross-wiring)', async () => {
    const { broker } = await composeHooksBroker(HOOK_TOKEN);
    const url = broker.hooks!.url;
    // Different values...
    expect(HOOK_TOKEN).not.toBe(broker.gateway.token);
    // ...and the endpoint enforces the HOOK token, not the gateway one: posting
    // the gateway bootstrap token as the hook header is rejected 401, while the
    // real per-install hook token is accepted.
    expect((await postHook(url, { [HOOK_TOKEN_HEADER]: broker.gateway.token })).status).toBe(401);
    expect((await postHook(url, { [HOOK_TOKEN_HEADER]: HOOK_TOKEN })).status).toBe(204);
  });

  it('without options.hooks the composed broker has no hooks endpoint (default composition unchanged)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aib-hooks-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    // A hook-token file is present, but with no options.hooks nothing reads it.
    writeFileSync(join(home, 'hook-token'), `${HOOK_TOKEN}\n`, { mode: 0o600 });
    const broker = await composeBroker({
      storePath: ':memory:',
      profiles: { aibenderHome: home },
      runner: new FakeQueryRunner({ mode: 'manual' }),
      baseEnv: {},
      logger: QUIET,
      gateway: { writeBootstrap: false, aibenderHome: home, logger: QUIET },
    });
    cleanups.push(() => broker.close());
    expect(broker.hooks).toBeUndefined();
  });
});
