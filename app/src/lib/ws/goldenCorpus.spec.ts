/**
 * Golden WS corpus replayed through the FE-2 client stack (plan §9.3 BE↔FE
 * #1; §9.2 FE-2 positive row "envelope round-trip against protocol
 * goldens"). The corpus in @aibender/testkit is THE contract device — this
 * suite replays the EXISTING fixtures through this package's own inbound
 * router and outbound builders; it never re-derives expectations.
 *
 * Inbound: every broker→client text fixture must produce the pinned verdict
 * from `routeBrokerFrame` (the real client path — not the testkit reference
 * replay). Binary fixtures round-trip through the frozen codec.
 *
 * Outbound: frames built by encodeEnvelope must be BYTE-IDENTICAL to the
 * corpus fixtures for the client→broker payload families FE-2 emits.
 */

import { describe, expect, it } from 'vitest';
import {
  GOLDEN_WS_CORPUS_FREEZE,
  GOLDEN_WS_FIXTURES,
  goldenFrameBytes,
  type GoldenWsBinaryFixture,
  type GoldenWsTextFixture,
} from '@aibender/testkit';
import { PROTOCOL_FREEZE, decodePtyFrame } from '@aibender/protocol';
import { routeBrokerFrame } from './inboundRouter.ts';
import { encodeEnvelope } from './outbound.ts';

const textFixtures = GOLDEN_WS_FIXTURES.filter((f): f is GoldenWsTextFixture => f.kind === 'text');
const binaryFixtures = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsBinaryFixture => f.kind === 'binary',
);

it('pins the same freeze as the protocol package', () => {
  expect(GOLDEN_WS_CORPUS_FREEZE).toBe(PROTOCOL_FREEZE);
});

describe('broker→client text fixtures through the FE inbound router', () => {
  const inbound = textFixtures.filter((f) => f.direction === 'broker-to-client');

  it('covers every broker→client fixture in the corpus', () => {
    expect(inbound.length).toBeGreaterThanOrEqual(25);
  });

  it.each(inbound.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const verdict = routeBrokerFrame(fixture.frame);
    if (fixture.expect.valid) {
      expect(verdict.ok).toBe(true);
    } else {
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe(fixture.expect.code);
    }
  });
});

describe('binary PTY frame fixtures through the frozen codec', () => {
  it.each(binaryFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const decoded = decodePtyFrame(goldenFrameBytes(fixture));
    expect(decoded.ok).toBe(fixture.expect.valid);
    if (!decoded.ok && !fixture.expect.valid) {
      expect(decoded.code).toBe(fixture.expect.code);
    }
    if (decoded.ok && fixture.decoded !== undefined) {
      expect(decoded.value.type).toBe(fixture.decoded.type);
      expect(decoded.value.sessionId).toBe(fixture.decoded.sessionId);
      expect(decoded.value.streamOffset).toBe(fixture.decoded.streamOffset);
      expect(new TextDecoder().decode(decoded.value.payload)).toBe(fixture.decoded.payloadUtf8);
    }
  });

  it('output frames route to the pty-frame message through the router', () => {
    const output = binaryFixtures.find((f) => f.name === 'pty-frame-output-valid');
    expect(output).toBeDefined();
    const verdict = routeBrokerFrame(goldenFrameBytes(output as GoldenWsBinaryFixture));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.message.kind).toBe('pty-frame');
  });
});

describe('outbound builders are byte-identical to client→broker fixtures', () => {
  function goldenFrame(name: string): string {
    const fixture = textFixtures.find((f) => f.name === name);
    if (fixture === undefined) throw new Error(`missing golden fixture ${name}`);
    return fixture.frame;
  }

  it('control-launch-min', () => {
    expect(
      encodeEnvelope('control', 0, {
        kind: 'launch',
        id: 'req_01',
        params: {
          accountLabel: 'MAX_A',
          backend: 'claude_code',
          substrate: 'sdk',
          cwd: '/synthetic/workspace',
          purpose: 'golden launch',
        },
      }),
    ).toBe(goldenFrame('control-launch-min'));
  });

  it('control-status-all', () => {
    expect(encodeEnvelope('control', 8, { kind: 'status', id: 'req_09' })).toBe(
      goldenFrame('control-status-all'),
    );
  });

  it('control-resume-with-prompt (ICR-0004 shape)', () => {
    expect(
      encodeEnvelope('control', 18, {
        kind: 'resume',
        id: 'req_20',
        params: { sessionId: 'ses_fake_1', fork: false, prompt: 'synthesized next user prompt' },
      }),
    ).toBe(goldenFrame('control-resume-with-prompt'));
  });

  it('approval-decision-allow', () => {
    expect(
      encodeEnvelope('approvals', 0, {
        kind: 'approval-decision',
        approvalId: 'apr_fake_1',
        verdict: 'allow',
        updatedInput: { command: 'ls -la' },
      }),
    ).toBe(goldenFrame('approval-decision-allow'));
  });

  it('replay-request-transcript-valid', () => {
    expect(
      encodeEnvelope('transcript.ses_fake_1', 0, {
        kind: 'replay-request',
        channel: 'transcript.ses_fake_1',
        fromSeq: 42,
      }),
    ).toBe(goldenFrame('replay-request-transcript-valid'));
  });

  it('pty-ack-valid', () => {
    expect(
      encodeEnvelope('pty.ses_fake_1', 0, {
        kind: 'pty-ack',
        sessionId: 'ses_fake_1',
        watermark: 4096,
      }),
    ).toBe(goldenFrame('pty-ack-valid'));
  });

  it('pty-resize-valid', () => {
    expect(
      encodeEnvelope('pty.ses_fake_1', 2, {
        kind: 'pty-resize',
        sessionId: 'ses_fake_1',
        cols: 80,
        rows: 24,
      }),
    ).toBe(goldenFrame('pty-resize-valid'));
  });
});
