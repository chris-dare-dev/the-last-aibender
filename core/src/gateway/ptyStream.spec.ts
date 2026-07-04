/**
 * PtySessionStream unit suite — the SPIKE-D ack-watermark consumer mechanics
 * (ws-protocol.md §5/§6; plan §9.2 BE-3 edge row "slow consumer → bounded
 * buffer + backpressure, no OOM" at the engine level; the wire-level half
 * lives in serverStreaming.spec.ts).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PTY_FLOW_CONTROL,
  PtyBufferOverflowError,
  PtySessionStream,
  type PtyConsumerHandle,
  type PtyDeliverySink,
  type PtyFlowControlOptions,
} from './ptyStream.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class RecordingProducer {
  pauseCount = 0;
  resumeCount = 0;
  paused = false;

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  resume(): void {
    this.paused = false;
    this.resumeCount += 1;
  }
}

class RecordingSink implements PtyDeliverySink {
  readonly slices: Array<{ offset: number; data: Uint8Array }> = [];

  deliver(offset: number, data: Uint8Array): void {
    this.slices.push({ offset, data: data.slice() });
  }

  bytes(): Uint8Array {
    const total = this.slices.reduce((sum, slice) => sum + slice.data.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const slice of this.slices) {
      out.set(slice.data, cursor);
      cursor += slice.data.byteLength;
    }
    return out;
  }

  utf8(): string {
    return new TextDecoder().decode(this.bytes());
  }

  deliveredBytes(): number {
    return this.slices.reduce((sum, slice) => sum + slice.data.byteLength, 0);
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const SMALL: Partial<PtyFlowControlOptions> = {
  capBytes: 64,
  highWater: 32,
  lowWater: 8,
  deliveryWindowBytes: 16,
  maxFramePayloadBytes: 8,
};

function attachOrThrow(
  stream: PtySessionStream,
  sink: PtyDeliverySink,
  fromWatermark: number,
): PtyConsumerHandle {
  const attached = stream.attach(sink, fromWatermark);
  if (!attached.ok) throw new Error(`attach refused: ${attached.message}`);
  return attached.consumer;
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe('PtySessionStream (positive)', () => {
  it('delivers pushed bytes with correct absolute offsets, in order', () => {
    const producer = new RecordingProducer();
    const stream = new PtySessionStream(producer, SMALL);
    const sink = new RecordingSink();
    attachOrThrow(stream, sink, 0);

    stream.push(bytes('hello '));
    stream.push(bytes('world'));

    expect(sink.utf8()).toBe('hello world');
    expect(sink.slices[0]?.offset).toBe(0);
    // Offsets are contiguous: each slice starts where the previous ended.
    let cursor = 0;
    for (const slice of sink.slices) {
      expect(slice.offset).toBe(cursor);
      cursor += slice.data.byteLength;
    }
  });

  it('splits delivery at maxFramePayloadBytes and never merges across the cap', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    const sink = new RecordingSink();
    attachOrThrow(stream, sink, 0);
    stream.push(bytes('0123456789abcdef')); // 16 bytes, frame cap 8
    expect(sink.slices.length).toBe(2);
    expect(sink.slices.every((slice) => slice.data.byteLength <= 8)).toBe(true);
    expect(sink.utf8()).toBe('0123456789abcdef');
  });

  it('a late attach replays retained bytes from the watermark', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    stream.push(bytes('0123456789')); // no consumers yet — retained
    const sink = new RecordingSink();
    attachOrThrow(stream, sink, 4);
    expect(sink.utf8()).toBe('456789');
    expect(sink.slices[0]?.offset).toBe(4);
  });

  it('acks release bytes and stale acks are ignored (monotonic §6)', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);
    stream.push(bytes('0123456789'));
    expect(consumer.ack(8).ok).toBe(true);
    expect(stream.stats().floor).toBe(8);
    expect(consumer.ack(4).ok).toBe(true); // stale: ignored, floor unchanged
    expect(stream.stats().floor).toBe(8);
    expect(consumer.offsets().acked).toBe(8);
  });

  it('fan-out: two consumers each receive every byte exactly once', () => {
    const stream = new PtySessionStream(new RecordingProducer(), {
      ...SMALL,
      deliveryWindowBytes: 64,
    });
    const sinkA = new RecordingSink();
    const sinkB = new RecordingSink();
    attachOrThrow(stream, sinkA, 0);
    stream.push(bytes('first-'));
    attachOrThrow(stream, sinkB, 0); // late joiner replays the retained window
    stream.push(bytes('second'));
    expect(sinkA.utf8()).toBe('first-second');
    expect(sinkB.utf8()).toBe('first-second');
  });

  it('replayFrom re-delivers retained bytes for an attached consumer (reconnect path)', () => {
    const stream = new PtySessionStream(new RecordingProducer(), {
      ...SMALL,
      deliveryWindowBytes: 64,
    });
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);
    stream.push(bytes('0123456789'));
    const before = sink.utf8();
    expect(before).toBe('0123456789');
    expect(consumer.replayFrom(6).ok).toBe(true);
    expect(sink.utf8()).toBe('01234567896789');
  });
});

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

describe('PtySessionStream (negative)', () => {
  it('attach below the release floor answers watermark-out-of-range', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);
    stream.push(bytes('0123456789'));
    consumer.ack(10); // floor rises to 10, bytes released
    const late = stream.attach(new RecordingSink(), 5);
    expect(late.ok).toBe(false);
    if (late.ok) throw new Error('expected refusal');
    expect(late.code).toBe('watermark-out-of-range');
  });

  it('attach beyond the stream head answers watermark-out-of-range', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    stream.push(bytes('01234'));
    const attached = stream.attach(new RecordingSink(), 6);
    expect(attached.ok).toBe(false);
    if (attached.ok) throw new Error('expected refusal');
    expect(attached.code).toBe('watermark-out-of-range');
  });

  it('an ack beyond the delivered offset answers watermark-out-of-range', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);
    stream.push(bytes('0123'));
    const result = consumer.ack(100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toBe('watermark-out-of-range');
  });

  it('replayFrom below the floor is unrecoverable by design', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);
    stream.push(bytes('0123456789'));
    consumer.ack(10);
    const result = consumer.replayFrom(2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toBe('watermark-out-of-range');
  });

  it('rejects invalid watermark configuration at construction', () => {
    const producer = new RecordingProducer();
    expect(() => new PtySessionStream(producer, { lowWater: 32, highWater: 32 })).toThrow(RangeError);
    expect(() => new PtySessionStream(producer, { highWater: 8 * 1024 * 1024 })).toThrow(RangeError);
    expect(() => new PtySessionStream(producer, { deliveryWindowBytes: 0 })).toThrow(RangeError);
    expect(
      () => new PtySessionStream(producer, { maxFramePayloadBytes: 2 * 1024 * 1024 }),
    ).toThrow(RangeError);
  });

  it('a cap breach throws PtyBufferOverflowError — a broker bug, not a wire condition', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    stream.push(new Uint8Array(32)); // paused at highWater — producer must stop
    stream.push(new Uint8Array(31)); // still under cap 64
    expect(() => stream.push(new Uint8Array(2))).toThrow(PtyBufferOverflowError);
  });
});

// ---------------------------------------------------------------------------
// Edge: bounded memory + backpressure (the SPIKE-D discipline)
// ---------------------------------------------------------------------------

describe('PtySessionStream (edge: slow consumer, bounded memory)', () => {
  it('a never-acking consumer receives at most deliveryWindowBytes in flight', () => {
    const stream = new PtySessionStream(new RecordingProducer(), SMALL);
    const sink = new RecordingSink();
    attachOrThrow(stream, sink, 0);
    stream.push(new Uint8Array(30));
    expect(sink.deliveredBytes()).toBe(16); // window cap, not 30
  });

  it('occupancy is bounded: highWater pauses the producer, drain resumes it', () => {
    const producer = new RecordingProducer();
    const stream = new PtySessionStream(producer, SMALL);
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);

    stream.push(new Uint8Array(16));
    expect(producer.paused).toBe(false);
    stream.push(new Uint8Array(16)); // occupancy 32 >= highWater 32
    expect(producer.paused).toBe(true);
    expect(producer.pauseCount).toBe(1);
    expect(stream.stats().occupancy).toBe(32);

    // Consumer catches up: window advances with acks, floor drains, resume.
    consumer.ack(16);
    expect(producer.paused).toBe(true); // occupancy 16 > lowWater 8
    consumer.ack(sink.deliveredBytes());
    consumer.ack(32);
    expect(stream.stats().occupancy).toBe(0);
    expect(producer.paused).toBe(false);
    expect(producer.resumeCount).toBe(1);
  });

  it('the SLOWEST consumer gates release: a fully-acked fast consumer cannot advance the floor', () => {
    const producer = new RecordingProducer();
    const stream = new PtySessionStream(producer, { ...SMALL, deliveryWindowBytes: 64 });
    const fast = attachOrThrow(stream, new RecordingSink(), 0);
    attachOrThrow(stream, new RecordingSink(), 0); // the slow one: never acks

    stream.push(new Uint8Array(32)); // both delivered; hits highWater
    expect(producer.paused).toBe(true);
    fast.ack(32); // fast consumer fully acked …
    expect(stream.stats().floor).toBe(0); // … but the slow one pins the floor
    expect(stream.stats().occupancy).toBe(32);
    expect(producer.paused).toBe(true);
  });

  it('detach of the pinning consumer releases bytes and resumes the producer', () => {
    const producer = new RecordingProducer();
    const stream = new PtySessionStream(producer, { ...SMALL, deliveryWindowBytes: 64 });
    const fast = attachOrThrow(stream, new RecordingSink(), 0);
    const slow = attachOrThrow(stream, new RecordingSink(), 0);

    stream.push(new Uint8Array(32));
    fast.ack(32);
    expect(producer.paused).toBe(true);
    expect(stream.stats().occupancy).toBe(32);

    slow.detach();
    expect(stream.stats().floor).toBe(32);
    expect(stream.stats().occupancy).toBe(0);
    expect(producer.paused).toBe(false);
  });

  it('bytes are NEVER dropped: a slow consumer that finally acks receives the full stream', () => {
    const producer = new RecordingProducer();
    const stream = new PtySessionStream(producer, SMALL);
    const sink = new RecordingSink();
    const consumer = attachOrThrow(stream, sink, 0);

    const sent: string[] = [];
    let pushed = 0;
    // Honor the pause lever exactly like a real producer would.
    for (let i = 0; i < 100 && !producer.paused; i += 1) {
      const chunk = `chunk-${String(i).padStart(2, '0')};`; // 9 bytes
      sent.push(chunk);
      stream.push(bytes(chunk));
      pushed += chunk.length;
    }
    expect(producer.paused).toBe(true); // backpressure engaged before cap
    expect(stream.stats().peakOccupancy).toBeLessThanOrEqual(64);

    // Drain: ack whatever has been delivered until the consumer is current.
    let guard = 0;
    while (sink.deliveredBytes() < pushed && guard < 1000) {
      consumer.ack(sink.deliveredBytes());
      guard += 1;
    }
    expect(sink.utf8()).toBe(sent.join(''));
    expect(producer.resumeCount).toBeGreaterThan(0);
  });

  it('markExited keeps the retained window replayable and mutes the levers', () => {
    const producer = new RecordingProducer();
    const stream = new PtySessionStream(producer, SMALL);
    stream.push(bytes('final output'));
    stream.markExited();
    stream.push(bytes('ignored')); // no producer after exit
    const sink = new RecordingSink();
    attachOrThrow(stream, sink, 0);
    expect(sink.utf8()).toBe('final output');
    expect(stream.stats().exited).toBe(true);
  });

  it('default flow-control values are the SPIKE-D soak numbers', () => {
    expect(DEFAULT_PTY_FLOW_CONTROL.capBytes).toBe(4 * 1024 * 1024);
    expect(DEFAULT_PTY_FLOW_CONTROL.highWater).toBe(2 * 1024 * 1024);
    expect(DEFAULT_PTY_FLOW_CONTROL.lowWater).toBe(512 * 1024);
  });
});
