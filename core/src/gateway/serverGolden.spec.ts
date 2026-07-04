/**
 * Golden protocol corpus vs the LIVE gateway (plan §9.3 BE↔FE #1; the
 * EXISTING corpus in @aibender/testkit — never a parallel one).
 *
 * Every client→broker fixture frame is replayed BYTE-FOR-BYTE through a real
 * WebSocket connection:
 *
 *  - fixtures pinned INVALID must draw exactly their frozen ErrorCode from
 *    the gateway (as a pushed error or a correlated result error);
 *  - fixtures pinned VALID must clear every VALIDATION-stage code. They MAY
 *    legally draw a RUNTIME-stage answer (`session-not-found` for a session
 *    that does not exist here, `watermark-out-of-range` for an empty journal,
 *    `approval-not-pending` for an approval nobody requested) — the corpus
 *    pins the validation verdict, not gateway state.
 *
 * Broker→client fixtures are the FE department's replay half (and testkit's
 * own suite runs the reference router over the full corpus). This suite adds
 * the outbound guarantee from the broker side: every frame the gateway sent
 * during the replay is itself validated against the frozen envelope +
 * payload validators.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL,
  PROTOCOL_FREEZE,
  validateControlResponse,
  validateEnvelope,
  validateErrorPayload,
  type Envelope,
  type ErrorCode,
} from '@aibender/protocol';
import {
  GOLDEN_WS_CORPUS_FREEZE,
  GOLDEN_WS_FIXTURES,
  goldenFrameBytes,
  type GoldenWsFixture,
} from '@aibender/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { FakeKernel, FakeQueryRunner } from './fakeKernel.js';
import { startGateway, type GatewayHandle } from './server.js';

// ---------------------------------------------------------------------------
// Verdict plumbing
// ---------------------------------------------------------------------------

/**
 * Codes only a VALIDATION stage can produce. A valid fixture drawing one of
 * these from the gateway is a contract violation; runtime-state codes
 * (session-not-found, watermark-out-of-range, approval-not-pending, …) are
 * not — the corpus does not pin gateway state.
 */
const VALIDATION_CODES: ReadonlySet<string> = new Set([
  'bad-envelope',
  'unknown-channel',
  'unknown-verb',
  'verb-reserved',
  'bad-request',
  'oversized-frame',
] satisfies ErrorCode[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Error code carried by an envelope (pushed error OR correlated result error). */
function errorCodeOf(envelope: Envelope): string | undefined {
  const payload = envelope.payload;
  if (!isRecord(payload)) return undefined;
  if (payload['kind'] === 'error' && typeof payload['code'] === 'string') return payload['code'];
  if (payload['kind'] === 'result' && payload['ok'] === false) {
    const error = payload['error'];
    if (isRecord(error) && typeof error['code'] === 'string') return error['code'];
  }
  return undefined;
}

class GoldenClient {
  readonly envelopes: Envelope[] = [];
  readonly outboundViolations: string[] = [];

  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // no fixture provokes broker binary output
      const parsed: unknown = JSON.parse(String(data));
      const validated = validateEnvelope(parsed);
      if (!validated.ok) {
        this.outboundViolations.push(`envelope: ${validated.message}`);
        return;
      }
      const envelope = validated.value;
      if (envelope.channel === CHANNEL.CONTROL) {
        const payload = envelope.payload;
        const result =
          isRecord(payload) && payload['kind'] === 'error'
            ? validateErrorPayload(payload)
            : validateControlResponse(payload);
        if (!result.ok) this.outboundViolations.push(`control payload: ${result.message}`);
      }
      this.envelopes.push(envelope);
    });
    ws.on('error', () => {
      /* closing races are expected */
    });
  }

  static async connect(url: string, token: string): Promise<GoldenClient> {
    const ws = new WsClient(`${url}/?token=${token}`);
    const client = new GoldenClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(fixture: GoldenWsFixture): void {
    if (fixture.kind === 'binary') {
      this.ws.send(goldenFrameBytes(fixture), { binary: true });
    } else {
      // EXACT frame bytes — replay verbatim, never re-serialize.
      this.ws.send(fixture.frame);
    }
  }

  async waitForCode(code: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!this.envelopes.some((envelope) => errorCodeOf(envelope) === code)) {
      if (Date.now() - start > timeoutMs) {
        const seen = this.envelopes.map((envelope) => errorCodeOf(envelope) ?? 'ok');
        throw new Error(`timed out waiting for code ${code}; saw [${seen.join(', ')}]`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async settle(windowMs = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let home: string;
let handle: GatewayHandle;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-golden-'));
  handle = await startGateway({
    kernel: new FakeKernel(new FakeQueryRunner()),
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
});

afterAll(async () => {
  await handle.close();
  await rm(home, { recursive: true, force: true });
});

describe('golden corpus ↔ gateway freeze agreement', () => {
  it('the gateway builds against the same freeze the corpus pins', () => {
    expect(GOLDEN_WS_CORPUS_FREEZE).toBe(PROTOCOL_FREEZE);
  });
});

describe('golden corpus client→broker replay through the live gateway', () => {
  const inbound = GOLDEN_WS_FIXTURES.filter((fixture) => fixture.direction === 'client-to-broker');

  it('the corpus has inbound fixtures to replay', () => {
    expect(inbound.length).toBeGreaterThanOrEqual(20);
  });

  for (const fixture of inbound) {
    it(`${fixture.name} → ${fixture.expect.valid ? 'accepted' : fixture.expect.code}`, async () => {
      const client = await GoldenClient.connect(handle.url, handle.token);
      try {
        client.send(fixture);
        if (!fixture.expect.valid) {
          await client.waitForCode(fixture.expect.code);
        } else {
          await client.settle();
          const validationHits = client.envelopes
            .map((envelope) => errorCodeOf(envelope))
            .filter((code): code is string => code !== undefined && VALIDATION_CODES.has(code));
          expect(validationHits).toEqual([]);
        }
        // Outbound half: everything the gateway answered with is itself
        // frozen-valid wire traffic.
        expect(client.outboundViolations).toEqual([]);
      } finally {
        client.close();
      }
    });
  }
});
