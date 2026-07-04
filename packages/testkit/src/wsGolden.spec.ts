import { describe, expect, it } from 'vitest';

import { ERROR_CODES, decodePtyFrame, encodePtyFrame } from '@aibender/protocol';

import { assertSynthesizedSafeText } from './jsonl.js';
import {
  GOLDEN_WS_FIXTURES,
  goldenFrameBytes,
  replayGoldenWsFixture,
  type GoldenWsBinaryFixture,
} from './wsGolden.js';

const TEXT = GOLDEN_WS_FIXTURES.filter((f) => f.kind === 'text');
const BINARY = GOLDEN_WS_FIXTURES.filter((f): f is GoldenWsBinaryFixture => f.kind === 'binary');

describe('golden WS-protocol fixture corpus (plan §9.3 BE↔FE #1; ICR-0003)', () => {
  // -- positive ---------------------------------------------------------------

  it('every fixture replays to its pinned verdict at its pinned stage', () => {
    for (const fixture of GOLDEN_WS_FIXTURES) {
      const outcome = replayGoldenWsFixture(fixture);
      expect(outcome.stage, fixture.name).toBe(fixture.stage);
      expect(outcome.valid, fixture.name).toBe(fixture.expect.valid);
      if (!fixture.expect.valid) {
        expect(outcome.code, fixture.name).toBe(fixture.expect.code);
      } else {
        expect(outcome.code, fixture.name).toBeUndefined();
      }
    }
  });

  it('valid binary fixtures decode to their pinned fields AND re-encode byte-identically', () => {
    for (const fixture of BINARY.filter((f) => f.expect.valid)) {
      const bytes = goldenFrameBytes(fixture);
      const decoded = decodePtyFrame(bytes);
      expect(decoded.ok, fixture.name).toBe(true);
      if (!decoded.ok || fixture.decoded === undefined) {
        throw new Error(`fixture ${fixture.name} must pin its decoded fields`);
      }
      expect(decoded.value.type).toBe(fixture.decoded.type);
      expect(decoded.value.sessionId).toBe(fixture.decoded.sessionId);
      expect(decoded.value.streamOffset).toBe(fixture.decoded.streamOffset);
      expect(new TextDecoder().decode(decoded.value.payload)).toBe(
        fixture.decoded.payloadUtf8,
      );
      // Round-trip pin: the frozen encoder must reproduce the golden bytes.
      expect(Buffer.from(encodePtyFrame(decoded.value)).toString('hex')).toBe(
        fixture.frameHex,
      );
    }
  });

  it('pins the exact bytes of the minimal launch frame (serialization guard)', () => {
    const fixture = TEXT.find((f) => f.name === 'control-launch-min');
    expect(fixture?.frame).toBe(
      '{"stream":"control","channel":"control","seq":0,"payload":' +
        '{"kind":"launch","id":"req_01","params":{"accountLabel":"MAX_A",' +
        '"backend":"claude_code","substrate":"sdk","cwd":"/synthetic/workspace",' +
        '"purpose":"golden launch"}}}',
    );
  });

  it('covers every frozen ErrorCode somewhere in the corpus (closed registry)', () => {
    const seen = new Set<string>();
    for (const fixture of GOLDEN_WS_FIXTURES) {
      if (!fixture.expect.valid) seen.add(fixture.expect.code);
      if (fixture.kind === 'text' && fixture.frame.startsWith('{')) {
        const payload = (JSON.parse(fixture.frame) as { payload?: unknown }).payload;
        if (typeof payload === 'object' && payload !== null) {
          const record = payload as Record<string, unknown>;
          if (typeof record['code'] === 'string') seen.add(record['code']);
          const error = record['error'];
          if (typeof error === 'object' && error !== null) {
            const detail = error as Record<string, unknown>;
            if (typeof detail['code'] === 'string') seen.add(detail['code']);
          }
        }
      }
    }
    for (const code of ERROR_CODES) {
      expect(seen.has(code), `no fixture exercises error code ${code}`).toBe(true);
    }
  });

  // -- negative ---------------------------------------------------------------

  it('contains no identity-shaped content in any frame [X2 fixture policy]', () => {
    for (const fixture of GOLDEN_WS_FIXTURES) {
      const text =
        fixture.kind === 'text'
          ? fixture.frame
          : new TextDecoder().decode(goldenFrameBytes(fixture));
      expect(() => assertSynthesizedSafeText(text), fixture.name).not.toThrow();
    }
  });

  it('goldenFrameBytes refuses malformed hex', () => {
    const bad = { ...BINARY[0]!, frameHex: 'abc' }; // odd length
    expect(() => goldenFrameBytes(bad)).toThrow(RangeError);
    const nonHex = { ...BINARY[0]!, frameHex: 'zz00' };
    expect(() => goldenFrameBytes(nonHex)).toThrow(RangeError);
  });

  // -- edge -------------------------------------------------------------------

  it('fixture names are unique (fixtures are addressed by name across departments)', () => {
    const names = GOLDEN_WS_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exercises both directions and both frame kinds', () => {
    expect(GOLDEN_WS_FIXTURES.some((f) => f.direction === 'client-to-broker')).toBe(true);
    expect(GOLDEN_WS_FIXTURES.some((f) => f.direction === 'broker-to-client')).toBe(true);
    expect(TEXT.length).toBeGreaterThan(0);
    expect(BINARY.length).toBeGreaterThan(0);
    // Every stage of the routing order is represented.
    const stages = new Set(GOLDEN_WS_FIXTURES.map((f) => f.stage));
    expect([...stages].sort()).toEqual(
      [
        'channel-policy',
        'control-request',
        'control-response',
        'envelope',
        'error-payload',
        'json-parse',
        'pty-client-message',
        'pty-frame-codec',
      ].sort(),
    );
  });
});
