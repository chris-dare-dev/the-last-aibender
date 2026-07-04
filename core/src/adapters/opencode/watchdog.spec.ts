import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RSS_SUSTAIN_MS,
  DEFAULT_RSS_THRESHOLD_BYTES,
  createSustainedRssTracker,
} from './watchdog.js';

const MB = 1024 * 1024;
const MIN = 60 * 1000;

describe('sustained-RSS watchdog (blueprint §4.2: sustained, never peaks)', () => {
  // -- edge (plan §9.2: serve GC sawtooth ignored, sustained RSS trips) -------

  it('ignores the Bun GC sawtooth: transient 650 MB spikes never trip', () => {
    const tracker = createSustainedRssTracker();
    // The probe's measured shape: boot 391 → spike 648 → settle 195 → 162.
    expect(tracker.sample(391 * MB, 0).tripped).toBe(false);
    expect(tracker.sample(648 * MB, 4 * MIN).tripped).toBe(false); // spike
    expect(tracker.sample(195 * MB, 9 * MIN).tripped).toBe(false); // settled
    expect(tracker.sample(620 * MB, 12 * MIN).tripped).toBe(false); // new spike
    expect(tracker.sample(162 * MB, 13 * MIN).tripped).toBe(false); // settled again
  });

  it('trips only after RSS stays above threshold for the FULL sustain window', () => {
    const tracker = createSustainedRssTracker();
    expect(tracker.sample(700 * MB, 0).tripped).toBe(false);
    expect(tracker.sample(710 * MB, 2 * MIN).tripped).toBe(false);
    expect(tracker.sample(705 * MB, 4 * MIN + 59_000).tripped).toBe(false);
    const verdict = tracker.sample(701 * MB, 5 * MIN);
    expect(verdict.tripped).toBe(true);
    expect(verdict.aboveForMs).toBe(DEFAULT_RSS_SUSTAIN_MS);
  });

  it('one settle below threshold resets the streak', () => {
    const tracker = createSustainedRssTracker();
    tracker.sample(700 * MB, 0);
    tracker.sample(200 * MB, 3 * MIN); // settles
    expect(tracker.sample(700 * MB, 4 * MIN).tripped).toBe(false);
    expect(tracker.sample(700 * MB, 8 * MIN).tripped).toBe(false); // only 4 min streak
    expect(tracker.sample(700 * MB, 9 * MIN).tripped).toBe(true);
  });

  // -- positive ---------------------------------------------------------------

  it('honors custom threshold/sustain and reset()', () => {
    const tracker = createSustainedRssTracker({ thresholdBytes: 100 * MB, sustainMs: 1000 });
    expect(tracker.sample(150 * MB, 0).tripped).toBe(false);
    expect(tracker.sample(150 * MB, 1000).tripped).toBe(true);
    tracker.reset();
    expect(tracker.sample(150 * MB, 1500).tripped).toBe(false); // streak forgotten
  });

  // -- negative ---------------------------------------------------------------

  it('exactly-at-threshold is BELOW (spiky processes get the benefit)', () => {
    const tracker = createSustainedRssTracker();
    expect(tracker.sample(DEFAULT_RSS_THRESHOLD_BYTES, 0).aboveForMs).toBe(0);
    expect(tracker.sample(DEFAULT_RSS_THRESHOLD_BYTES, 10 * MIN).tripped).toBe(false);
  });
});
