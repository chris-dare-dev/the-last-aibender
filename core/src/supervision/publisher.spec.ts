/**
 * BE-9 resource-health publisher (plan §9.2): the governor's snapshot rides the
 * frozen events channel exactly like the ten §6.3 leads.
 *   positive — a valid resource-health snapshot is validated + published;
 *   negative — an invalid snapshot THROWS (programmer error), never published;
 *   edge     — the min-valid golden-corpus shape publishes unchanged.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ResourceHealthSnapshot } from '@aibender/protocol';

import { createResourceHealthPublisher } from './publisher.js';

// The min-valid golden shape (testkit events-readmodel-resource-health-min-valid).
function minValid(): ResourceHealthSnapshot {
  return {
    kind: 'read-model-snapshot',
    readModel: 'resource-health',
    capturedAt: 90100000,
    sources: [{ source: 'lmstudio', state: 'fresh', lastIngestAt: 90099000 }],
    data: {
      pressureLevel: 0,
      pressureState: 'normal',
      freeRamPct: 62.5,
      swapUsedBytes: 0,
      residentSessionCount: 0,
      sessions: [],
      notices: [],
    },
  };
}

describe('BE-9 resource-health publisher', () => {
  it('validates + publishes a valid snapshot onto the events channel (positive)', () => {
    const publishEvent = vi.fn();
    const publisher = createResourceHealthPublisher({ sink: { publishEvent } });
    const snapshot = minValid();
    publisher.publish(snapshot);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toEqual(snapshot);
  });

  it('publishes the full red-pressure sacrifice-order snapshot (golden full-valid shape)', () => {
    const publishEvent = vi.fn();
    const publisher = createResourceHealthPublisher({ sink: { publishEvent } });
    const snapshot: ResourceHealthSnapshot = {
      kind: 'read-model-snapshot',
      readModel: 'resource-health',
      capturedAt: 90100500,
      sources: [{ source: 'lmstudio', state: 'lmstudio-down' }],
      data: {
        pressureLevel: 4,
        pressureState: 'red',
        freeRamPct: 9.5,
        swapUsedBytes: 27917287424,
        residentSessionCount: 3,
        localModelResidentBytes: 0,
        sessions: [
          { account: 'MAX_A', backend: 'claude_code', slot: 0, footprintMb: 2100, band: 'ok' },
          { account: 'AWS_DEV', backend: 'opencode', slot: 0, footprintMb: 1600, band: 'recycle', hibernated: false },
        ],
        notices: [
          { action: 'shed-local-model', at: 90100400 },
          { action: 'hibernate-non-account', at: 90100450, account: 'AWS_DEV', backend: 'opencode' },
          { action: 'recycle-session', at: 90100480, account: 'MAX_A', backend: 'claude_code' },
        ],
      },
    };
    publisher.publish(snapshot);
    expect(publishEvent).toHaveBeenCalledTimes(1);
  });

  it('THROWS on an invalid snapshot and never publishes it (negative)', () => {
    const publishEvent = vi.fn();
    const publisher = createResourceHealthPublisher({ sink: { publishEvent } });
    const bad = minValid() as unknown as { data: Record<string, unknown> };
    // pressureLevel out of the 0..4 range → the frozen validator rejects.
    const invalid = { ...bad, data: { ...bad.data, pressureLevel: 9 } };
    expect(() => publisher.publish(invalid as unknown as ResourceHealthSnapshot)).toThrow(RangeError);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('THROWS on a per-session label/backend pairing violation (negative [X2])', () => {
    const publishEvent = vi.fn();
    const publisher = createResourceHealthPublisher({ sink: { publishEvent } });
    const base = minValid();
    const invalid: ResourceHealthSnapshot = {
      ...base,
      data: {
        ...base.data,
        residentSessionCount: 1,
        // MAX_A must be claude_code, not opencode — the frozen pairing.
        sessions: [{ account: 'MAX_A', backend: 'opencode', slot: 0, footprintMb: 1, band: 'ok' }],
      },
    };
    expect(() => publisher.publish(invalid)).toThrow(RangeError);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
