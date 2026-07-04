/**
 * M2 GATE soak: 6-PTY flow control + echo latency against the REAL
 * gateway + REAL ptyHost + REAL node-pty children (plan §8.2 M2 DoD
 * "6-PTY soak passes with flow control engaged (bounded memory, no dropped
 * bytes); typing echo p95 <100 ms locally"; §9.3 BE↔FE #2; SPIKE-D
 * mechanics re-proven on the composed M2 chain).
 *
 * The ONLY synthetic piece is the TUI itself (flood.cjs / quiet.cjs — real
 * node children on real PTYs; a real `claude` TUI is T3 owner-gated,
 * docs/runbooks/pty-attended-live.md). Everything else is the production
 * path: createNodePtySpawner -> createPtyHost -> toGatewayPtyHostPort ->
 * startGateway -> WebSocket clients speaking the FROZEN wire protocol.
 *
 * Phases:
 *  1. SOAK — 6 attended sessions flood ~4 MiB each. Every session has a
 *     prompt-acking fast consumer; session 0 ALSO has a slow consumer that
 *     withholds acks for a window. Proves: delivery window caps in-flight
 *     bytes; the producer PAUSES (producedOffset plateaus while the slow
 *     consumer stalls — the real child is blocked in a TTY write); RSS
 *     stays bounded; after the slow consumer drains, EVERY consumer holds
 *     the complete byte-exact stream (zero loss, zero duplication —
 *     contiguous-offset reassembly throws on either).
 *  2. ECHO — a quiet TUI echoes keystrokes via the TTY driver; 200
 *     sequential keystrokes measured send -> OUTPUT-frame; report p50/p95.
 *
 * Run: pnpm -F aibender-core soak:m2   (exit 0 = every criterion met)
 * [X2]: synthesized fixtures only; no accounts, no keychain, no real TUIs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodePtyFrame,
  encodePtyFrame,
  ptyChannel,
  streamForChannel,
  validateEnvelope,
  type ChannelName,
  type PtyFrame,
} from '@aibender/protocol';
import { openKernelStore } from '@aibender/schema';
import { WebSocket as WsClient } from 'ws';

import { startGateway } from '../../src/gateway/index.js';
import { FakeKernel, FakeQueryRunner } from '../../src/gateway/fakeKernel.js';
import {
  createNodePtySpawner,
  createPtyHost,
  createProfileRegistry,
  toGatewayPtyHostPort,
  type AttendedPtySession,
  type ClaudeProfileLabel,
} from '../../src/kernel/index.js';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const SESSIONS = 6;
const LINES_PER_SESSION = 65_536; // 61-byte lines -> ~3.8 MiB payload each
const SLOW_STALL_MS = 1500; // slow-consumer ack blackout window
const ECHO_SAMPLES = 200;
const ECHO_P95_BUDGET_MS = 100; // plan §8.2 M2 DoD
const RSS_BOUND_BYTES = 512 * 1024 * 1024; // peak delta bound (24 MiB payload)
const SOAK_TIMEOUT_MS = 120_000;

const LABELS: readonly ClaudeProfileLabel[] = ['MAX_A', 'MAX_B', 'ENT'];
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Wire client (frozen protocol, binary + text)
// ---------------------------------------------------------------------------

class SoakClient {
  received = 0;
  readonly chunks: PtyFrame[] = [];
  errors: string[] = [];
  private seq = 0;
  private constructor(
    private readonly ws: WsClient,
    private readonly sessionId: string,
  ) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const decoded = decodePtyFrame(
          new Uint8Array((data as Buffer).buffer, (data as Buffer).byteOffset, (data as Buffer).byteLength),
        );
        if (!decoded.ok) {
          this.errors.push(`frame failed the frozen codec: ${decoded.message}`);
          return;
        }
        if (decoded.value.sessionId !== this.sessionId) return;
        if (decoded.value.streamOffset !== this.received) {
          this.errors.push(
            `non-contiguous stream: expected offset ${this.received}, got ${decoded.value.streamOffset}`,
          );
          return;
        }
        this.chunks.push(decoded.value);
        this.received += decoded.value.payload.byteLength;
        this.onFrame?.();
        return;
      }
      const validated = validateEnvelope(JSON.parse(String(data)));
      if (!validated.ok) this.errors.push(`bad envelope: ${validated.message}`);
      else if (
        typeof validated.value.payload === 'object' &&
        validated.value.payload !== null &&
        (validated.value.payload as Record<string, unknown>)['kind'] === 'error'
      ) {
        this.errors.push(`broker error: ${JSON.stringify(validated.value.payload)}`);
      }
    });
    ws.on('error', () => {});
  }

  /** Called after every accepted OUTPUT frame (ack strategies hook here). */
  onFrame: (() => void) | undefined;

  static async connect(url: string, token: string, sessionId: string): Promise<SoakClient> {
    const ws = new WsClient(`${url}/?token=${token}`);
    const client = new SoakClient(ws, sessionId);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  attach(): void {
    this.sendJson({ kind: 'pty-replay-request', sessionId: this.sessionId, fromWatermark: 0 });
  }

  ack(): void {
    this.sendJson({ kind: 'pty-ack', sessionId: this.sessionId, watermark: this.received });
  }

  sendInput(bytes: Uint8Array): void {
    this.ws.send(
      encodePtyFrame({ type: 'input', sessionId: this.sessionId, streamOffset: 0, payload: bytes }),
      { binary: true },
    );
  }

  private sendJson(payload: unknown): void {
    const channel = ptyChannel(this.sessionId) as ChannelName;
    this.ws.send(
      JSON.stringify({ stream: streamForChannel(channel), channel, seq: this.seq++, payload }),
    );
  }

  utf8(): string {
    let text = '';
    const decoder = new TextDecoder();
    for (const frame of this.chunks) text += decoder.decode(frame.payload, { stream: true });
    return text + decoder.decode();
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`soak timed out waiting for ${what}`);
    await sleep(10);
  }
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * The exact byte stream flood.cjs produces for one session, as on the wire
 * (the PTY line discipline maps the child's `\n` to `\r\n` — ONLCR).
 */
function expectedFloodText(index: number): string {
  const pad = 'x'.repeat(48);
  let text = '';
  for (let seq = 0; seq < LINES_PER_SESSION; seq += 1) {
    text += `S${index}:${String(seq).padStart(8, '0')}:${pad}\r\n`;
  }
  return text;
}

/** Wire bytes per session (identical for every single-digit session index). */
const EXPECTED_WIRE_BYTES = expectedFloodText(0).length;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), 'aibender-m2-soak-'));
  const cwd = mkdtempSync(join(tmpdir(), 'aibender-m2-soak-cwd-'));
  const store = await openKernelStore({ path: ':memory:' });

  let nextArgv: readonly string[] = [];
  const host = createPtyHost({
    ledger: store.resumeLedger,
    profiles: createProfileRegistry({ aibenderHome: home }),
    backend: createNodePtySpawner({
      liveSpawnOptIn: true,
      // Synthetic TUIs: node running flood.cjs / quiet.cjs — NEVER `claude`.
      pathToClaudeCodeExecutable: process.execPath,
    }),
    argv: () => nextArgv,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const gateway = await startGateway({
    kernel: new FakeKernel(new FakeQueryRunner()),
    ptyHost: toGatewayPtyHostPort(host),
    aibenderHome: home,
    writeBootstrap: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const rssBaseline = process.memoryUsage().rss;
  let rssPeak = rssBaseline;
  const rssTimer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 100);

  const failures: string[] = [];
  const clients: SoakClient[] = [];
  const sessions: AttendedPtySession[] = [];

  try {
    // ---- phase 1: 6-PTY soak ---------------------------------------------
    const startedAt = Date.now();
    for (let i = 0; i < SESSIONS; i += 1) {
      nextArgv = [join(HERE, 'flood.cjs'), String(i), String(LINES_PER_SESSION)];
      sessions.push(
        await host.launchAttended({
          accountLabel: LABELS[i % LABELS.length]!,
          backend: 'claude_code',
          substrate: 'pty',
          cwd,
          purpose: `m2 gate soak session ${i}`,
        }),
      );
    }

    const fast: SoakClient[] = [];
    for (let i = 0; i < SESSIONS; i += 1) {
      const client = await SoakClient.connect(gateway.url, gateway.token, sessions[i]!.sessionId);
      client.onFrame = () => client.ack(); // prompt consumer
      client.attach();
      fast.push(client);
      clients.push(client);
    }

    // The ONE slow consumer (session 0): attaches, then withholds every ack.
    const slow = await SoakClient.connect(gateway.url, gateway.token, sessions[0]!.sessionId);
    slow.attach();
    clients.push(slow);

    // Stall window: the delivery window must cap the slow consumer, and the
    // producer must PLATEAU (the real child blocked in a TTY write).
    await sleep(SLOW_STALL_MS * 0.6);
    const plateauA = sessions[0]!.producedOffset();
    await sleep(SLOW_STALL_MS * 0.4);
    const plateauB = sessions[0]!.producedOffset();
    const slowInFlight = slow.received;

    if (plateauB !== plateauA) {
      failures.push(
        `producer did not plateau under a stalled consumer: producedOffset ${plateauA} -> ${plateauB}`,
      );
    }
    if (plateauB >= EXPECTED_WIRE_BYTES) {
      failures.push('flow control never engaged: session 0 produced everything despite the stall');
    }
    if (slowInFlight > 1024 * 1024) {
      failures.push(`slow consumer in-flight bytes ${slowInFlight} exceed the 1 MiB delivery window`);
    }

    // Slow consumer starts draining: ack on every frame + a nudge loop for
    // window-boundary wakeups.
    slow.onFrame = () => slow.ack();
    const nudge = setInterval(() => slow.ack(), 50);

    await waitFor(
      () => fast.every((c) => c.received >= EXPECTED_WIRE_BYTES) && slow.received >= EXPECTED_WIRE_BYTES,
      'all consumers to hold the complete streams',
      SOAK_TIMEOUT_MS,
    );
    clearInterval(nudge);
    const soakWallMs = Date.now() - startedAt;

    // Byte-exactness: every consumer reassembled the EXACT emitted stream.
    for (let i = 0; i < SESSIONS; i += 1) {
      const expected = expectedFloodText(i);
      const got = fast[i]!.utf8();
      if (got !== expected) {
        failures.push(
          `session ${i} fast consumer stream mismatch: ${got.length} bytes vs ${expected.length} expected`,
        );
      }
      if (fast[i]!.received !== sessions[i]!.producedOffset()) {
        failures.push(
          `session ${i}: consumer got ${fast[i]!.received} bytes, host produced ${sessions[i]!.producedOffset()}`,
        );
      }
    }
    if (slow.utf8() !== expectedFloodText(0)) {
      failures.push('slow consumer stream mismatch after drain');
    }
    for (const client of clients) failures.push(...client.errors);

    const rssPeakDelta = rssPeak - rssBaseline;
    if (rssPeakDelta > RSS_BOUND_BYTES) {
      failures.push(`RSS delta ${rssPeakDelta} exceeded the ${RSS_BOUND_BYTES} bound`);
    }

    // ---- phase 2: echo latency --------------------------------------------
    nextArgv = [join(HERE, 'quiet.cjs')];
    const echoSession = await host.launchAttended({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'pty',
      cwd,
      purpose: 'm2 gate echo latency',
    });
    const echo = await SoakClient.connect(gateway.url, gateway.token, echoSession.sessionId);
    echo.onFrame = () => echo.ack();
    echo.attach();
    await sleep(150); // let the child and the attach settle

    const latencies: number[] = [];
    for (let i = 0; i < ECHO_SAMPLES; i += 1) {
      const expectedBytes = echo.received + 1;
      // Latency is captured ON the frame-arrival hook (no poll quantization).
      const echoed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`echo byte ${i} timed out`)), 5000);
        echo.onFrame = () => {
          echo.ack();
          if (echo.received >= expectedBytes) {
            clearTimeout(timer);
            resolve(performance.now());
          }
        };
      });
      const sentAt = performance.now();
      echo.sendInput(new Uint8Array([97 + (i % 26)])); // 'a'..'z'
      latencies.push((await echoed) - sentAt);
    }
    echo.close();
    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    if (p95 >= ECHO_P95_BUDGET_MS) {
      failures.push(`echo p95 ${p95.toFixed(2)} ms breaches the <${ECHO_P95_BUDGET_MS} ms budget`);
    }

    // ---- report ------------------------------------------------------------
    const report = {
      soak: {
        sessions: SESSIONS,
        slowConsumers: 1,
        expectedWireBytesPerSession: EXPECTED_WIRE_BYTES,
        totalWireBytes: EXPECTED_WIRE_BYTES * SESSIONS,
        wallMs: soakWallMs,
        flowControl: {
          producerPlateauedAtBytes: plateauB,
          plateauStable: plateauA === plateauB,
          slowConsumerInFlightAtStall: slowInFlight,
          deliveryWindowBytes: 1024 * 1024,
        },
        rss: { baseline: rssBaseline, peak: rssPeak, peakDelta: rssPeak - rssBaseline },
        byteLoss: failures.some((f) => f.includes('mismatch') || f.includes('contiguous')) ? 'FAILED' : 0,
      },
      echo: {
        samples: ECHO_SAMPLES,
        p50Ms: Number(p50.toFixed(3)),
        p95Ms: Number(p95.toFixed(3)),
        p99Ms: Number(p99.toFixed(3)),
        maxMs: Number(latencies[latencies.length - 1]!.toFixed(3)),
        budgetMs: ECHO_P95_BUDGET_MS,
      },
      failures,
      verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    };
    console.log(JSON.stringify(report, null, 2));
    return failures.length === 0 ? 0 : 1;
  } finally {
    clearInterval(rssTimer);
    for (const client of clients) client.close();
    await host.shutdown(); // reaps every synthetic child (process-group kill)
    await gateway.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    console.error('m2 gate soak crashed:', cause);
    process.exit(1);
  },
);
