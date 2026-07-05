/**
 * BE-9 per-session footprint watchdog (plan §9.2 BE-9 row):
 *   positive — warn/recycle at the documented thresholds (fake phys_footprint
 *              feed) per backend;
 *   negative — a naive/absent reading never fabricates a band; a serve dip
 *              below the line resets the sustained window;
 *   edge     — threshold-flapping hysteresis; the opencode-serve sustained
 *              window (GC-sawtooth-proof debounce).
 *
 * The sampler is a FAKE driven by the test — NO real process is ever bloated.
 */

import { describe, expect, it } from 'vitest';

import { createFootprintWatchdog } from './watchdog.js';
import type { FootprintSampler, SupervisedSession } from './types.js';

// --- a fake phys_footprint sampler the test scripts, MB per session ----------
function fakeSampler(byId: Map<string, number | undefined>): FootprintSampler {
  return { sampleMb: (session) => byId.get(session.sessionId) };
}

const claudeSession: SupervisedSession = {
  sessionId: 'ses_claude',
  account: 'MAX_A',
  backend: 'claude_code',
  watchdogClass: 'claude',
  slot: 0,
  isAccountSession: true,
};
const opencodeSession: SupervisedSession = {
  sessionId: 'ses_oc',
  account: 'AWS_DEV',
  backend: 'opencode',
  watchdogClass: 'opencode',
  slot: 0,
  isAccountSession: false,
};
const serveSession: SupervisedSession = {
  sessionId: 'ses_serve',
  account: 'AWS_DEV',
  backend: 'opencode',
  watchdogClass: 'opencode-serve',
  slot: 1,
  isAccountSession: false,
};

describe('BE-9 footprint watchdog — thresholds per backend (positive)', () => {
  it('claude: warn at 3 GB, recycle at 6 GB', () => {
    const byId = new Map<string, number | undefined>();
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId) });

    byId.set('ses_claude', 2000); // < 3 GB
    expect(wd.evaluate([claudeSession], 0)[0]?.band).toBe('ok');

    byId.set('ses_claude', 3072); // == 3 GB warn line
    expect(wd.evaluate([claudeSession], 1)[0]?.band).toBe('warn');

    byId.set('ses_claude', 6144); // == 6 GB recycle line
    expect(wd.evaluate([claudeSession], 2)[0]?.band).toBe('recycle');
  });

  it('opencode agent: warn at 1 GB, recycle at 1.5 GB', () => {
    const byId = new Map<string, number | undefined>();
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId) });

    byId.set('ses_oc', 900);
    expect(wd.evaluate([opencodeSession], 0)[0]?.band).toBe('ok');
    byId.set('ses_oc', 1024);
    expect(wd.evaluate([opencodeSession], 1)[0]?.band).toBe('warn');
    byId.set('ses_oc', 1536);
    expect(wd.evaluate([opencodeSession], 2)[0]?.band).toBe('recycle');
  });

  it('opencode serve: NO recycle band exists (it is scheduler-shed, not recycled)', () => {
    const byId = new Map<string, number | undefined>([['ses_serve', 5000]]);
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId) });
    // Way over any line, sustained window elapsed: bands at most `warn`.
    const v = wd.evaluate([serveSession], 400_000)[0];
    // sustained window (300 s) not yet met at t=400_000 with a fresh start:
    // first reading arms the clock, so this is still `ok` until the window elapses.
    expect(v?.band).not.toBe('recycle');
  });
});

describe('BE-9 footprint watchdog — sustained window (opencode serve, edge)', () => {
  it('trips warn ONLY after 5 min sustained over 500 MB', () => {
    const byId = new Map<string, number | undefined>([['ses_serve', 600]]);
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId) });

    // t=0: first reading over 500 MB arms the sustained clock; still ok.
    expect(wd.evaluate([serveSession], 0)[0]?.band).toBe('ok');
    // t=299s: window not yet elapsed.
    expect(wd.evaluate([serveSession], 299_000)[0]?.band).toBe('ok');
    // t=300s: window elapsed → warn.
    expect(wd.evaluate([serveSession], 300_000)[0]?.band).toBe('warn');
  });

  it('a GC-sawtooth dip below 500 MB RESETS the window (negative — never trips)', () => {
    const byId = new Map<string, number | undefined>([['ses_serve', 600]]);
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId) });

    wd.evaluate([serveSession], 0); // arm at 600
    wd.evaluate([serveSession], 200_000); // still 600
    byId.set('ses_serve', 160); // GC drops it below the line → RESET
    expect(wd.evaluate([serveSession], 250_000)[0]?.band).toBe('ok');
    byId.set('ses_serve', 650); // climbs again → re-arms the clock at t=260s
    wd.evaluate([serveSession], 260_000);
    // t=559s: only 299 s since the re-arm → still ok (proves the reset).
    expect(wd.evaluate([serveSession], 559_000)[0]?.band).toBe('ok');
    // t=560s: 300 s since the re-arm → warn.
    expect(wd.evaluate([serveSession], 560_000)[0]?.band).toBe('warn');
  });
});

describe('BE-9 footprint watchdog — hysteresis + no-reading (edge/negative)', () => {
  it('does not flap warn↔ok on noise at the warn line', () => {
    const byId = new Map<string, number | undefined>();
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId), hysteresisMb: 128 });

    byId.set('ses_oc', 1030); // over 1 GB warn → warn
    expect(wd.evaluate([opencodeSession], 0)[0]?.band).toBe('warn');
    byId.set('ses_oc', 1000); // dips just under, but within the 128 MB margin → HOLDS warn
    expect(wd.evaluate([opencodeSession], 1)[0]?.band).toBe('warn');
    byId.set('ses_oc', 800); // clears the margin (1024-128=896) → drops to ok
    expect(wd.evaluate([opencodeSession], 2)[0]?.band).toBe('ok');
  });

  it('an absent reading holds the last band and never fabricates one (negative)', () => {
    const byId = new Map<string, number | undefined>();
    const wd = createFootprintWatchdog({ sampler: fakeSampler(byId) });

    byId.set('ses_claude', 3200); // warn
    expect(wd.evaluate([claudeSession], 0)[0]?.band).toBe('warn');
    byId.set('ses_claude', undefined); // sampler gap
    const v = wd.evaluate([claudeSession], 1)[0];
    expect(v?.band).toBe('warn'); // held, not fabricated to ok
    expect(v?.footprintMb).toBeUndefined();
  });

  it('a sampler that THROWS is treated as no reading, never propagates', () => {
    const throwing: FootprintSampler = {
      sampleMb: () => {
        throw new Error('sampler blew up');
      },
    };
    const wd = createFootprintWatchdog({ sampler: throwing });
    expect(() => wd.evaluate([claudeSession], 0)).not.toThrow();
    expect(wd.evaluate([claudeSession], 1)[0]?.band).toBe('ok');
  });
});
