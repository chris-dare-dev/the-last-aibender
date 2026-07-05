/**
 * §9.3 BE↔FE #1 — golden protocol fixtures replayed against BOTH the FE
 * client and the BE gateway, with the cross-department agreement assertion
 * that the per-department suites cannot make on their own.
 *
 * The two per-department suites each replay the SAME frozen corpus
 * (`GOLDEN_WS_FIXTURES`) through their own stack:
 *   - FE: app/src/lib/ws/goldenCorpus.spec.ts → `routeBrokerFrame`;
 *   - BE: core/src/gateway/serverGolden.spec.ts → the live gateway.
 * Each asserts its OWN stack matches the corpus. Neither asserts the OTHER
 * stack agrees frame-for-frame — that cross-check is THIS suite's job and is
 * the actual anti-seam-drift device the contract-of-record note
 * (docs/contracts/integration-suite.md §1) names: a fixture change bumps
 * PROTOCOL_FREEZE and BOTH stacks must re-agree on every byte, or this fails.
 *
 * We assemble (never re-derive):
 *   - the FE inbound router (`routeBrokerFrame`) — the REAL client path;
 *   - the BE reference replay (`replayGoldenWsFixture`) — the gateway's
 *     routing order, which serverGolden.spec.ts proves the live gateway
 *     matches;
 *   - the frozen corpus itself.
 *
 * [X2]: every fixture is synthesized in the testkit; we screen the corpus.
 */

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_FREEZE,
  decodePtyFrame,
  type ErrorCode,
} from '@aibender/protocol';
import {
  GOLDEN_WS_CORPUS_FREEZE,
  GOLDEN_WS_FIXTURES,
  goldenFrameBytes,
  replayGoldenWsFixture,
  type GoldenWsBinaryFixture,
  type GoldenWsFixture,
  type GoldenWsTextFixture,
} from '@aibender/testkit';

// The REAL FE client inbound path — assembled by relative path (the
// sanctioned cross-cutting pattern; see core/scripts/m2-soak/run.ts).
import { routeBrokerFrame } from '../../../../app/src/lib/ws/inboundRouter.ts';

type SideVerdict = { readonly valid: true } | { readonly valid: false; readonly code: ErrorCode };

/** BE side: the reference replay whose verdicts the live gateway is proven to match. */
function beVerdict(fixture: GoldenWsFixture): SideVerdict {
  const r = replayGoldenWsFixture(fixture);
  return r.valid ? { valid: true } : { valid: false, code: r.code as ErrorCode };
}

/** FE side: the client's real inbound router (broker→client frames only). */
function feVerdict(fixture: GoldenWsFixture): SideVerdict {
  const data =
    fixture.kind === 'binary' ? goldenFrameBytes(fixture) : fixture.frame;
  const verdict = routeBrokerFrame(data);
  return verdict.ok ? { valid: true } : { valid: false, code: verdict.code };
}

const brokerToClient = GOLDEN_WS_FIXTURES.filter((f) => f.direction === 'broker-to-client');
const textFixtures = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsTextFixture => f.kind === 'text',
);
const binaryFixtures = GOLDEN_WS_FIXTURES.filter(
  (f): f is GoldenWsBinaryFixture => f.kind === 'binary',
);

describe('BE↔FE #1 — golden corpus, both departments pin the same freeze', () => {
  it('the corpus freeze equals the protocol freeze (the anti-drift constant)', () => {
    expect(GOLDEN_WS_CORPUS_FREEZE).toBe(PROTOCOL_FREEZE);
  });

  it('the corpus is non-trivial (guards against an emptied fixture set)', () => {
    expect(GOLDEN_WS_FIXTURES.length).toBeGreaterThanOrEqual(40);
    expect(brokerToClient.length).toBeGreaterThanOrEqual(25);
  });
});

describe('BE↔FE #1 — broker→client fixtures: FE client and BE reference AGREE frame-for-frame', () => {
  // The FE inbound router only routes broker→client frames; that is exactly
  // the direction where both departments touch the same bytes on the wire.
  it.each(brokerToClient.map((f) => [f.name, f] as const))(
    '%s — same verdict on both sides',
    (_name, fixture) => {
      const be = beVerdict(fixture);
      const fe = feVerdict(fixture);
      // Agreement first: the cross-department invariant.
      expect(fe).toEqual(be);
      // And both must match the frozen corpus expectation (belt + braces).
      if (fixture.expect.valid) {
        expect(be.valid).toBe(true);
        expect(fe.valid).toBe(true);
      } else {
        expect(be).toEqual({ valid: false, code: fixture.expect.code });
        expect(fe).toEqual({ valid: false, code: fixture.expect.code });
      }
    },
  );
});

describe('BE↔FE #1 — binary PTY frames: identical codec verdict on both sides', () => {
  it.each(binaryFixtures.map((f) => [f.name, f] as const))(
    '%s — byte-identical decode both sides',
    (_name, fixture) => {
      // FE inbound router + BE reference both defer to the ONE frozen codec.
      const feDecoded = decodePtyFrame(goldenFrameBytes(fixture));
      const be = beVerdict(fixture);
      expect(feDecoded.ok).toBe(be.valid);
      if (fixture.expect.valid && feDecoded.ok && fixture.decoded !== undefined) {
        expect(feDecoded.value.type).toBe(fixture.decoded.type);
        expect(feDecoded.value.sessionId).toBe(fixture.decoded.sessionId);
        expect(feDecoded.value.streamOffset).toBe(fixture.decoded.streamOffset);
        expect(new TextDecoder().decode(feDecoded.value.payload)).toBe(fixture.decoded.payloadUtf8);
      }
    },
  );
});

describe('BE↔FE #1 — [X2] every golden frame is identity-free', () => {
  // The corpus builders screen through the jsonl identity-shape guard; this
  // is the INTEG-level backstop that the assembled bytes carry no identity.
  const TWELVE_DIGIT = /(?<!\d)\d{12}(?!\d)/;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  it('no broker→client text frame contains an AWS-account-shaped run or a real-looking email', () => {
    for (const fixture of textFixtures) {
      // Fixtures deliberately include obviously-synthetic addresses guarded
      // by the testkit; we assert the STRONG shapes are absent from frames.
      const twelve = TWELVE_DIGIT.test(fixture.frame);
      expect(twelve, `${fixture.name} carries a 12-digit run`).toBe(false);
      // Emails only ever appear inside runtime-built OTLP drop-probes (never
      // in the WS corpus); assert none leaked into the wire frames here.
      const email = EMAIL.test(fixture.frame);
      expect(email, `${fixture.name} carries an email-shaped token`).toBe(false);
    }
  });
});
