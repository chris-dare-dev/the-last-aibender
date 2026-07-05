/**
 * BE-9 compose-ready slice (createSupervisionSlice) — the seam core/src/main/
 * injects, mirroring the M4 workstream / M5 pipeline slices:
 *   - tickAndPublish runs one governor pass AND publishes the snapshot onto
 *     the (fake) events sink;
 *   - a publish failure is swallowed (the tick result still returns);
 *   - with no sink the tick runs but nothing publishes (degraded, documented).
 */

import { describe, expect, it, vi } from 'vitest';

import { createSupervisionSlice } from './index.js';
import type { FootprintSampler, PressureProbe, PressureReading, SupervisedSession } from './types.js';

const calm: PressureReading = { pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 0 };
const sampler: FootprintSampler = { sampleMb: () => 2000 };
const probe: PressureProbe = { read: () => calm };
const session: SupervisedSession = {
  sessionId: 'ses_acct',
  account: 'MAX_A',
  backend: 'claude_code',
  watchdogClass: 'claude',
  slot: 0,
  isAccountSession: true,
};

describe('BE-9 supervision slice', () => {
  it('tickAndPublish runs a pass and publishes the resource-health snapshot', async () => {
    const publishEvent = vi.fn();
    const slice = createSupervisionSlice({ sampler, probe, sink: { publishEvent } });
    slice.governor.register(session);
    const result = await slice.tickAndPublish(1);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(result.snapshot.readModel).toBe('resource-health');
    expect(slice.snapshotOf(result)).toBe(result.snapshot);
  });

  it('swallows a publish failure — the tick result still returns', async () => {
    const slice = createSupervisionSlice({
      sampler,
      probe,
      sink: {
        publishEvent: () => {
          throw new Error('wire down');
        },
      },
    });
    slice.governor.register(session);
    await expect(slice.tickAndPublish(1)).resolves.toMatchObject({
      snapshot: { readModel: 'resource-health' },
    });
  });

  it('with no sink the tick runs but nothing publishes (documented degrade)', async () => {
    const slice = createSupervisionSlice({ sampler, probe });
    slice.governor.register(session);
    const result = await slice.tickAndPublish(1);
    expect(result.snapshot.readModel).toBe('resource-health');
  });
});
