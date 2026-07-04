/**
 * PtyConduit byte-axis discipline (ws-protocol.md §5/§6, SPIKE-D posture).
 * Positive: pre-attach buffering flushes on subscribe; acks coalesce.
 * Negative: INPUT/foreign-session frames ignored.
 * Edge: byte gap triggers replay-from-consumed; duplicate replay is
 *       trimmed; broker restart resets every axis.
 */

import { describe, expect, it } from 'vitest';
import { encodePtyFrame, type PtyClientMessage } from '@aibender/protocol';
import { nullLogger } from '../log.ts';
import { PtyConduit } from './ptyConduit.ts';

function outputFrame(sessionId: string, streamOffset: number, text: string) {
  const decoded = encodePtyFrame({
    type: 'output',
    sessionId,
    streamOffset,
    payload: new TextEncoder().encode(text),
  });
  // decode round-trip gives the PtyFrame shape handleFrame expects
  return {
    type: 'output' as const,
    sessionId,
    streamOffset,
    payload: new TextEncoder().encode(text),
    encoded: decoded,
  };
}

function makeConduit(): { conduit: PtyConduit; json: PtyClientMessage[]; binary: Uint8Array[] } {
  const json: PtyClientMessage[] = [];
  const binary: Uint8Array[] = [];
  const conduit = new PtyConduit(
    'ses_fake_1',
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
  return { conduit, json, binary };
}

describe('PtyConduit', () => {
  it('buffers bytes arriving before attach and flushes them on subscribe', () => {
    const { conduit } = makeConduit();
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'early '));
    expect(conduit.bufferedBytes).toBe(6);
    const chunks: string[] = [];
    conduit.onBytes((c) => chunks.push(new TextDecoder().decode(c)));
    expect(chunks.join('')).toBe('early ');
    expect(conduit.bufferedBytes).toBe(0);
  });

  it('ignores frames for other sessions and input-typed frames (negative)', () => {
    const { conduit } = makeConduit();
    const chunks: string[] = [];
    conduit.onBytes((c) => chunks.push(new TextDecoder().decode(c)));
    conduit.handleFrame(outputFrame('ses_other', 0, 'nope'));
    conduit.handleFrame({ ...outputFrame('ses_fake_1', 0, 'nope'), type: 'input' as const });
    expect(chunks).toEqual([]);
  });

  it('coalesces consume() calls into one ack per microtask', async () => {
    const { conduit, json } = makeConduit();
    conduit.onBytes(() => {});
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'abcdef'));
    conduit.consume(2);
    conduit.consume(2);
    conduit.consume(2);
    await Promise.resolve();
    await Promise.resolve();
    const acks = json.filter((m) => m.kind === 'pty-ack');
    expect(acks).toEqual([{ kind: 'pty-ack', sessionId: 'ses_fake_1', watermark: 6 }]);
  });

  it('a byte-axis gap requests replay from the consumed watermark (edge)', () => {
    const { conduit, json } = makeConduit();
    conduit.onBytes(() => {});
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'ab'));
    conduit.consume(2);
    conduit.handleFrame(outputFrame('ses_fake_1', 10, 'gap!'));
    const replays = json.filter((m) => m.kind === 'pty-replay-request');
    expect(replays).toEqual([
      { kind: 'pty-replay-request', sessionId: 'ses_fake_1', fromWatermark: 2 },
    ]);
  });

  it('trims overlapping replay so no byte is delivered twice (edge)', () => {
    const { conduit } = makeConduit();
    const chunks: string[] = [];
    conduit.onBytes((c) => chunks.push(new TextDecoder().decode(c)));
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'hello'));
    // Replay overlaps [3..5) then continues.
    conduit.handleFrame(outputFrame('ses_fake_1', 3, 'lo world'));
    expect(chunks.join('')).toBe('hello world');
    // Full-duplicate replay is dropped outright.
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'hello'));
    expect(chunks.join('')).toBe('hello world');
  });

  it('broker restart resets every axis (edge)', () => {
    const { conduit, json } = makeConduit();
    conduit.onBytes(() => {});
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'boot one'));
    conduit.consume(8);
    conduit.handleBrokerRestart();
    expect(conduit.consumedWatermark).toBe(0);
    expect(conduit.deliveredWatermark).toBe(0);
    // New boot restarts the byte axis at 0 — accepted cleanly.
    const chunks: string[] = [];
    conduit.onBytes((c) => chunks.push(new TextDecoder().decode(c)));
    conduit.handleFrame(outputFrame('ses_fake_1', 0, 'boot two'));
    expect(chunks.join('')).toBe('boot two');
    expect(json.filter((m) => m.kind === 'pty-replay-request')).toHaveLength(0);
  });
});
