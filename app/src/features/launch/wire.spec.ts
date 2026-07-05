/**
 * FE-5 wire tests — dispatch envelope validity pinned against the EXISTING
 * golden protocol corpus (packages/testkit; plan §9.2 FE-5 + §9.3 BE↔FE #1).
 *
 *  positive — the launcher's builders reproduce every valid golden
 *             `control-launch-*` frame BYTE-FOR-BYTE, and every launcher-
 *             producible dispatch replays as valid through the frozen
 *             validators (the same routing the gateway applies);
 *  negative — the invalid golden launch frames are UNREPRESENTABLE through
 *             the launcher's draft layer, and buildLaunchRequest refuses
 *             their params outright; malformed broker responses
 *             (unknown state, unregistered error code) land in `invalid`;
 *  edge     — response correlation: wrong id / wrong verb answers are never
 *             treated as broker truth.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_LABELS,
  LABEL_BACKENDS,
  validateControlRequest,
  validateEnvelope,
  type LaunchParams,
} from '@aibender/protocol';
import {
  GOLDEN_WS_CORPUS_FREEZE,
  GOLDEN_WS_FIXTURES,
  replayGoldenWsFixture,
  type GoldenWsTextFixture,
} from '@aibender/testkit';

import { stubFeatureDetect } from './featureDetect.ts';
import { validateLaunchDraft, emptyLaunchDraft } from './launchDraft.ts';
import { buildLaunchRequest, controlEnvelope, interpretLaunchResponse, serializeControlFrame } from './wire.ts';

// ---------------------------------------------------------------------------
// Golden corpus helpers
// ---------------------------------------------------------------------------

const textFixture = (name: string): GoldenWsTextFixture => {
  const fixture = GOLDEN_WS_FIXTURES.find((f) => f.name === name);
  if (fixture === undefined || fixture.kind !== 'text') {
    throw new Error(`golden corpus is missing text fixture ${name}`);
  }
  return fixture;
};

interface ParsedControlFrame {
  readonly seq: number;
  readonly payload: Record<string, unknown>;
}

const parseFrame = (fixture: GoldenWsTextFixture): ParsedControlFrame => {
  const parsed = JSON.parse(fixture.frame) as { seq: number; payload: Record<string, unknown> };
  return { seq: parsed.seq, payload: parsed.payload };
};

/** Rebuild params through the LAUNCHER's key ordering (launchDraft order). */
const orderParams = (raw: Record<string, unknown>): LaunchParams =>
  ({
    accountLabel: raw['accountLabel'],
    backend: raw['backend'],
    substrate: raw['substrate'],
    cwd: raw['cwd'],
    purpose: raw['purpose'],
    ...(raw['workstreamHint'] !== undefined ? { workstreamHint: raw['workstreamHint'] } : {}),
    ...(raw['prompt'] !== undefined ? { prompt: raw['prompt'] } : {}),
  }) as LaunchParams;

const VALID_LAUNCH_FIXTURES = [
  'control-launch-min',
  'control-launch-full',
  'control-launch-pty',
  'control-launch-local',
] as const;

describe('FE-5 wire — golden corpus (positive)', () => {
  it('pins the same protocol freeze as the corpus', () => {
    // Literal advanced by the BE-ORCH M3 freeze steward (events union closed;
    // FE-ORCH co-sign pending, bundled with the M3 freeze co-sign).
    expect(GOLDEN_WS_CORPUS_FREEZE).toBe('FROZEN-M4');
  });

  for (const name of VALID_LAUNCH_FIXTURES) {
    it(`reproduces ${name} byte-for-byte through the launcher builders`, () => {
      const fixture = textFixture(name);
      const { seq, payload } = parseFrame(fixture);
      const params = orderParams(payload['params'] as Record<string, unknown>);
      const request = buildLaunchRequest(payload['id'] as string, params);
      const frame = serializeControlFrame(controlEnvelope(seq, request));
      expect(frame).toBe(fixture.frame);
    });
  }

  it('produces dispatches that replay as valid through the frozen validators for every label', () => {
    const detect = stubFeatureDetect();
    for (const [index, label] of ACCOUNT_LABELS.entries()) {
      const verdict = validateLaunchDraft(
        {
          ...emptyLaunchDraft(),
          account: label,
          cwd: '/synthetic/workspace',
          purpose: 'golden launch parity',
          prompt: 'synthesized one-off prompt',
        },
        detect,
      );
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) continue;
      const request = buildLaunchRequest(`req_fe5_${String(index)}`, verdict.params);
      const frame = serializeControlFrame(controlEnvelope(index, request));

      // Route exactly the way the gateway routes an inbound text frame —
      // the corpus's reference replay over a launcher-built fixture.
      const replay = replayGoldenWsFixture({
        name: `fe5-launch-${label}`,
        kind: 'text',
        direction: 'client-to-broker',
        frame,
        stage: 'control-request',
        expect: { valid: true },
      });
      expect(replay).toEqual({ valid: true, stage: 'control-request' });

      // Belt and braces: envelope + request validators directly.
      const envelope = validateEnvelope(JSON.parse(frame));
      expect(envelope.ok).toBe(true);
      expect(validateControlRequest(request).ok).toBe(true);
    }
  });

  it('derives the frozen backend pairing for every label (mismatch unrepresentable)', () => {
    const detect = stubFeatureDetect();
    for (const label of ACCOUNT_LABELS) {
      const verdict = validateLaunchDraft(
        {
          ...emptyLaunchDraft(),
          account: label,
          cwd: '/synthetic/workspace',
          purpose: 'pairing audit',
          prompt: 'synthesized',
        },
        detect,
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.params.backend).toBe(LABEL_BACKENDS[label]);
        expect(verdict.params.substrate).toBe('sdk');
      }
    }
  });
});

describe('FE-5 wire — golden corpus (negative)', () => {
  const INVALID_LAUNCH_FIXTURES = [
    'control-launch-label-backend-mismatch',
    'control-launch-pty-non-claude',
    'control-launch-relative-cwd',
  ] as const;

  for (const name of INVALID_LAUNCH_FIXTURES) {
    it(`refuses to build the params of golden fixture ${name}`, () => {
      const fixture = textFixture(name);
      const { payload } = parseFrame(fixture);
      const params = orderParams(payload['params'] as Record<string, unknown>);
      expect(() => buildLaunchRequest(payload['id'] as string, params)).toThrow(RangeError);
    });
  }

  it('refuses a request id that violates REQUEST_ID_RE', () => {
    expect(() =>
      buildLaunchRequest('bad id!', {
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        substrate: 'sdk',
        cwd: '/synthetic/workspace',
        purpose: 'id audit',
      }),
    ).toThrow(RangeError);
  });

  it('refuses a negative envelope seq (programmer error, never wire data)', () => {
    expect(() => controlEnvelope(-1, {})).toThrow(RangeError);
  });

  it('rejects golden result-unknown-state as invalid (never rendered as broker truth)', () => {
    const { payload } = parseFrame(textFixture('result-unknown-state'));
    expect(interpretLaunchResponse(payload, 'req_01').kind).toBe('invalid');
  });

  it('rejects golden result-unregistered-error-code as invalid (closed code registry)', () => {
    const { payload } = parseFrame(textFixture('result-unregistered-error-code'));
    expect(interpretLaunchResponse(payload, 'req_01').kind).toBe('invalid');
  });
});

describe('FE-5 wire — response interpretation (edge)', () => {
  it('accepts golden result-launch-ok with the matching request id', () => {
    const { payload } = parseFrame(textFixture('result-launch-ok'));
    expect(interpretLaunchResponse(payload, 'req_01')).toEqual({
      kind: 'accepted',
      sessionId: 'ses_fake_1',
      state: 'spawning',
    });
  });

  it('treats an id mismatch as invalid, not as broker truth', () => {
    const { payload } = parseFrame(textFixture('result-launch-ok'));
    expect(interpretLaunchResponse(payload, 'req_99').kind).toBe('invalid');
  });

  it('treats a non-launch verb answer as invalid even when the id matches', () => {
    const { payload } = parseFrame(textFixture('result-resume-fork-ok'));
    expect(interpretLaunchResponse(payload, 'req_06').kind).toBe('invalid');
  });

  it('surfaces golden result-error-internal as a wire-error with the frozen code', () => {
    const { payload } = parseFrame(textFixture('result-error-internal'));
    const outcome = interpretLaunchResponse(payload, 'req_01');
    expect(outcome.kind).toBe('wire-error');
    if (outcome.kind === 'wire-error') {
      expect(outcome.error.code).toBe('internal');
      expect(outcome.error.retryable).toBe(false);
    }
  });

  it('accepts any registered SessionState on a launch result (M1 composition note)', () => {
    for (const state of ['spawning', 'running', 'exited'] as const) {
      const outcome = interpretLaunchResponse(
        {
          kind: 'result',
          id: 'req_01',
          ok: true,
          result: { verb: 'launch', sessionId: 'ses_fake_1', state },
        },
        'req_01',
      );
      expect(outcome).toEqual({ kind: 'accepted', sessionId: 'ses_fake_1', state });
    }
  });
});
