/**
 * PtyConduit → TerminalPtyPort adapter (M2 composition fix; plan §9.2 FE-2):
 * Positive: OUTPUT chunks surface {streamOffset, bytes}; input/resize route
 *           to the conduit's wire surface.
 * Negative: stale/duplicate absolute acks never regress the wire ack axis.
 * Edge:     bytes queued before onOutput carry correct offsets;
 *           requestReplay repositions the delivered axis so replayed bytes
 *           re-flow instead of being dropped as overlap; replay below the
 *           acked floor is clamped to it (§6 — released bytes are
 *           unrecoverable by design).
 */

import { describe, expect, it } from 'vitest';
import type { PtyClientMessage, PtyFrame } from '@aibender/protocol';
import { nullLogger } from '../log.ts';
import { PtyConduit } from '../ws/ptyConduit.ts';
import type { PtyOutputChunk } from '../../islands/terminal/port.ts';
import { terminalPortForConduit } from './terminalPort.ts';

const SID = 'ses_fake_1';

function outputFrame(streamOffset: number, text: string): PtyFrame {
  return { type: 'output', sessionId: SID, streamOffset, payload: new TextEncoder().encode(text) };
}

function harness() {
  const json: PtyClientMessage[] = [];
  const binary: Uint8Array[] = [];
  const conduit = new PtyConduit(
    SID,
    {
      sendJson: (payload) => {
        json.push(payload);
        return true;
      },
      sendBinary: (frame) => {
        binary.push(frame);
        return true;
      },
    },
    nullLogger,
  );
  const port = terminalPortForConduit(conduit);
  const chunks: PtyOutputChunk[] = [];
  return { conduit, port, json, binary, chunks };
}

const text = (c: PtyOutputChunk) => new TextDecoder().decode(c.bytes);

describe('terminalPortForConduit', () => {
  it('surfaces OUTPUT chunks as {streamOffset, bytes} pairs (positive)', () => {
    const h = harness();
    h.port.onOutput((c) => h.chunks.push(c));
    h.conduit.handleFrame(outputFrame(0, 'hello '));
    h.conduit.handleFrame(outputFrame(6, 'world'));
    expect(h.chunks.map((c) => [c.streamOffset, text(c)])).toEqual([
      [0, 'hello '],
      [6, 'world'],
    ]);
  });

  it('surfaces the TRIMMED offset on partial replay overlap (positive)', () => {
    const h = harness();
    h.port.onOutput((c) => h.chunks.push(c));
    h.conduit.handleFrame(outputFrame(0, 'hello'));
    // Overlapping replay [3..11): only [5..11) is new — offset must say so.
    h.conduit.handleFrame(outputFrame(3, 'lo world'));
    expect(h.chunks.map((c) => [c.streamOffset, text(c)])).toEqual([
      [0, 'hello'],
      [5, ' world'],
    ]);
  });

  it('bytes queued before onOutput carry correct offsets (edge)', () => {
    const h = harness();
    h.conduit.handleFrame(outputFrame(0, 'ab'));
    h.conduit.handleFrame(outputFrame(2, 'cdef'));
    h.port.onOutput((c) => h.chunks.push(c));
    expect(h.chunks.map((c) => [c.streamOffset, text(c)])).toEqual([
      [0, 'ab'],
      [2, 'cdef'],
    ]);
  });

  it('routes input and resize to the conduit wire surface (positive)', () => {
    const h = harness();
    h.port.sendInput(new TextEncoder().encode('ls\n'));
    expect(h.binary).toHaveLength(1);
    h.port.sendResize(120, 40);
    expect(h.json).toContainEqual({ kind: 'pty-resize', sessionId: SID, cols: 120, rows: 40 });
  });

  it('maps absolute ack watermarks onto relative consumption (positive)', async () => {
    const h = harness();
    h.port.onOutput(() => {});
    h.conduit.handleFrame(outputFrame(0, 'abcdef'));
    h.port.sendAck(4);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.json.filter((m) => m.kind === 'pty-ack')).toEqual([
      { kind: 'pty-ack', sessionId: SID, watermark: 4 },
    ]);
  });

  it('stale/duplicate absolute acks are a no-op (negative)', async () => {
    const h = harness();
    h.port.onOutput(() => {});
    h.conduit.handleFrame(outputFrame(0, 'abcdef'));
    h.port.sendAck(6);
    await Promise.resolve();
    await Promise.resolve();
    h.port.sendAck(6); // duplicate
    h.port.sendAck(3); // stale — must never regress
    await Promise.resolve();
    await Promise.resolve();
    const acks = h.json.filter((m) => m.kind === 'pty-ack');
    expect(acks).toEqual([{ kind: 'pty-ack', sessionId: SID, watermark: 6 }]);
    expect(h.conduit.consumedWatermark).toBe(6);
  });

  it('requestReplay repositions the delivered axis so replayed bytes re-flow (edge)', () => {
    const h = harness();
    h.port.onOutput((c) => h.chunks.push(c));
    h.conduit.handleFrame(outputFrame(0, 'hello world'));
    // Reattach path: island restored a snapshot consumed up to offset 6 and
    // asks the wire for everything after it.
    h.port.requestReplay(6);
    expect(h.json.filter((m) => m.kind === 'pty-replay-request')).toEqual([
      { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 6 },
    ]);
    // WITHOUT the reposition the conduit would drop this as already-delivered.
    h.conduit.handleFrame(outputFrame(6, 'world'));
    const last = h.chunks.at(-1) as PtyOutputChunk;
    expect([last.streamOffset, text(last)]).toEqual([6, 'world']);
  });

  it('replay below the acked floor is clamped to the floor (edge, §6)', async () => {
    const h = harness();
    h.port.onOutput(() => {});
    h.conduit.handleFrame(outputFrame(0, 'abcdef'));
    h.port.sendAck(6);
    await Promise.resolve();
    await Promise.resolve();
    // Bytes below the ack are released broker-side — unrecoverable by design.
    h.port.requestReplay(2);
    expect(h.json.filter((m) => m.kind === 'pty-replay-request')).toEqual([
      { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 6 },
    ]);
    expect(h.conduit.consumedWatermark).toBe(6);
    expect(h.conduit.deliveredWatermark).toBe(6);
  });
});
