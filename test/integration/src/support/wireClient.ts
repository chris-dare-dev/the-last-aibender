/**
 * Minimal frozen-protocol WebSocket client for the INTEG live-wire seams.
 *
 * This is deliberately a THIN reflection of the per-department wire clients
 * (core/src/main/m2ApprovalRoundTrip.spec.ts `WireClient`,
 * core/src/gateway/serverGolden.spec.ts `GoldenClient`,
 * core/scripts/m2-soak/run.ts `SoakClient`) — the INTEG suite drives the REAL
 * gateway the same way a real FE client would, decoding every inbound frame
 * through the FROZEN @aibender/protocol validators. It adds nothing to the
 * protocol; it only collects frames so a cross-department assertion can see
 * both ends of a seam.
 *
 * [X2]: never carries identity — only synthesized labels/ids/paths flow here.
 */

import {
  decodePtyFrame,
  streamForChannel,
  validateEnvelope,
  type ChannelName,
  type Envelope,
  type PtyFrame,
} from '@aibender/protocol';
import { WebSocket as WsClient } from 'ws';

export interface WireClientOptions {
  /** Called for every valid inbound text envelope. */
  readonly onEnvelope?: (envelope: Envelope) => void;
  /** Called for every valid inbound binary PTY frame. */
  readonly onPtyFrame?: (frame: PtyFrame) => void;
}

/**
 * A frozen-wire client that records everything the broker pushes. Text
 * frames are validated through {@link validateEnvelope}; binary frames
 * through {@link decodePtyFrame}. Anything that fails validation is recorded
 * as an outbound-contract violation (the broker must never emit an invalid
 * frame).
 */
export class WireClient {
  readonly envelopes: Envelope[] = [];
  readonly ptyFrames: PtyFrame[] = [];
  readonly outboundViolations: string[] = [];
  private nextSeqByChannel = new Map<ChannelName, number>();

  private constructor(
    private readonly ws: WsClient,
    private readonly options: WireClientOptions,
  ) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const decoded = decodePtyFrame(data as Uint8Array);
        if (!decoded.ok) {
          this.outboundViolations.push(`pty-frame: ${decoded.code}`);
          return;
        }
        this.ptyFrames.push(decoded.value);
        this.options.onPtyFrame?.(decoded.value);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        this.outboundViolations.push('json-parse');
        return;
      }
      const validated = validateEnvelope(parsed);
      if (!validated.ok) {
        this.outboundViolations.push(`envelope: ${validated.code}`);
        return;
      }
      this.envelopes.push(validated.value);
      this.options.onEnvelope?.(validated.value);
    });
    ws.on('error', () => {
      /* connection-close races are expected in these teardown-heavy suites */
    });
  }

  static connect(url: string, token: string, options: WireClientOptions = {}): Promise<WireClient> {
    return new Promise((resolve, reject) => {
      const ws = new WsClient(`${url}/?token=${token}`);
      const client = new WireClient(ws, options);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  /**
   * Send a frozen-protocol text envelope (client → broker), built exactly as
   * the per-department wire clients build it (ws-protocol.md §2:
   * `{stream, channel, seq, payload}`, per-connection monotonic seq).
   */
  send(channel: ChannelName, payload: Readonly<Record<string, unknown>>): void {
    const seq = this.nextSeqByChannel.get(channel) ?? 0;
    this.nextSeqByChannel.set(channel, seq + 1);
    this.ws.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload }));
  }

  /** Raw send of a pre-built frame (bytes are the contract — never re-serialize). */
  sendRaw(frame: string | Uint8Array): void {
    this.ws.send(frame);
  }

  close(): void {
    this.ws.close();
  }

  /** Terminate hard (used to simulate a mid-stream disconnect). */
  terminate(): void {
    this.ws.terminate();
  }

  envelopesOn(channel: ChannelName): Envelope[] {
    return this.envelopes.filter((e) => e.channel === channel);
  }
}

/** Poll until a predicate holds or the deadline passes. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
