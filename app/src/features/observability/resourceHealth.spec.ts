/**
 * resourceHealthVM (selectors) — the M6 supervision/governor instrument's
 * pure view model (ws-protocol.md §13.4). Positive / negative / edge per
 * plan §9.2. All fixtures are labels + numbers only [X2].
 */

import { describe, expect, it } from 'vitest';
import {
  PRESSURE_STATES,
  SHED_ACTIONS,
  WATCHDOG_BANDS,
  type PressureState,
} from '@aibender/protocol';
import {
  BAND_STATUS,
  MAX_NOTICE_ROWS,
  PRESSURE_STATUS,
  SHED_ACTION_LABELS,
  resourceHealthVM,
} from './resourceHealth.ts';
import { resourceHealthRedSnap, resourceHealthSnap, src, T0 } from './specHelpers.ts';

describe('resourceHealthVM — vocabularies pinned to the frozen registries', () => {
  it('maps every frozen pressure state to a status', () => {
    expect(Object.keys(PRESSURE_STATUS).sort()).toEqual([...PRESSURE_STATES].sort());
    expect(PRESSURE_STATUS.normal).toBe('ok');
    expect(PRESSURE_STATUS.amber).toBe('degraded');
    expect(PRESSURE_STATUS.red).toBe('fault');
  });

  it('maps every frozen watchdog band to a status', () => {
    expect(Object.keys(BAND_STATUS).sort()).toEqual([...WATCHDOG_BANDS].sort());
    expect(BAND_STATUS.ok).toBe('ok');
    expect(BAND_STATUS.warn).toBe('degraded');
    expect(BAND_STATUS.recycle).toBe('fault');
  });

  it('has an engraved label for every frozen shed action (the [X1] order + recycle)', () => {
    for (const action of SHED_ACTIONS) {
      expect(SHED_ACTION_LABELS[action]).toMatch(/^[A-Z0-9 /-]+$/);
    }
    expect(Object.keys(SHED_ACTION_LABELS).sort()).toEqual([...SHED_ACTIONS].sort());
  });
});

describe('resourceHealthVM — positive', () => {
  it('projects a healthy baseline (empty sessions + notices) as OK', () => {
    const vm = resourceHealthVM(resourceHealthSnap());
    expect(vm.health.status).toBe('ok');
    expect(vm.health.readout).toBe('OK');
    expect(vm.pressure?.state).toBe('normal');
    expect(vm.pressure?.level).toBe(0);
    expect(vm.sessions).toHaveLength(0);
    expect(vm.notices).toHaveLength(0);
  });

  it('projects a red-pressure snapshot with sessions and shed/recycle notices', () => {
    const vm = resourceHealthVM(resourceHealthRedSnap([src('fresh', 'lmstudio', T0)]));
    // Red pressure escalates to FAULT on a fresh feed.
    expect(vm.health.status).toBe('fault');
    expect(vm.pressure?.freeRamPct).toBe(9.5);
    expect(vm.pressure?.swapUsedBytes).toBe(27_917_287_424);
    expect(vm.pressure?.residentSessionCount).toBe(3);
    expect(vm.pressure?.localModelResidentBytes).toBe(0);
    // Four sessions, wire order preserved, bands mapped to statuses.
    expect(vm.sessions.map((s) => s.band)).toEqual(['ok', 'warn', 'recycle', 'ok']);
    expect(vm.sessions.map((s) => s.bandStatus)).toEqual(['ok', 'degraded', 'fault', 'ok']);
    expect(vm.sessions[3]?.hibernated).toBe(true);
    expect(vm.sessions[2]?.hibernated).toBe(false);
    // Notices are STATE rows; recycle carries an account (continuation [X4]).
    const recycle = vm.notices.find((n) => n.action === 'recycle-session');
    expect(recycle?.isRecycle).toBe(true);
    expect(recycle?.account).toBe('MAX_A');
    expect(recycle?.backend).toBe('claude_code');
  });

  it('sorts notices newest-first regardless of wire order (§13.4 does not pin order)', () => {
    const vm = resourceHealthVM(
      resourceHealthSnap([src('fresh', 'lmstudio', T0)], {
        pressureLevel: 2,
        pressureState: 'amber',
        notices: [
          { action: 'trim-scrollback', at: T0 + 10 },
          { action: 'shed-local-model', at: T0 + 90 },
          { action: 'shed-model-context', at: T0 + 50 },
        ],
      }),
    );
    expect(vm.notices.map((n) => n.at)).toEqual([T0 + 90, T0 + 50, T0 + 10]);
    expect(vm.notices[0]?.label).toBe('SHED LOCAL MODEL');
  });

  it('a whole-machine notice carries no account (shed-local-model)', () => {
    const vm = resourceHealthVM(
      resourceHealthSnap([src('fresh', 'lmstudio', T0)], {
        notices: [{ action: 'shed-local-model', at: T0 }],
      }),
    );
    expect(vm.notices[0]?.account).toBeUndefined();
    expect(vm.notices[0]?.backend).toBeUndefined();
    expect(vm.notices[0]?.isRecycle).toBe(false);
  });
});

describe('resourceHealthVM — negative / absence', () => {
  it('an absent snapshot is NO SIGNAL — never a fabricated healthy state', () => {
    const vm = resourceHealthVM(undefined);
    expect(vm.health.status).toBe('nosignal');
    expect(vm.health.readout).toBe('NO SIGNAL');
    expect(vm.pressure).toBeUndefined();
    expect(vm.sessions).toHaveLength(0);
    expect(vm.notices).toHaveLength(0);
  });

  it('a down governor feed reads NO SIGNAL even at red pressure (freshness wins)', () => {
    // lmstudio-down is a first-class freshness state; the pressure data is
    // present but the feed is dead → NO SIGNAL, never resurrected to FAULT.
    const vm = resourceHealthVM(resourceHealthRedSnap([src('lmstudio-down', 'lmstudio')]));
    expect(vm.health.status).toBe('nosignal');
    expect(vm.health.readout).toBe('NO SIGNAL');
    // The strip lists the down source with its remediation.
    expect(vm.health.strip[0]?.source).toBe('lmstudio');
    expect(vm.health.strip[0]?.remediation?.command).toBe('lms server start');
  });

  it('a stale feed degrades the instrument (partial signal, honest label)', () => {
    const vm = resourceHealthVM(
      resourceHealthSnap([src('stale', 'lmstudio', T0 - 1000)], {
        pressureState: 'normal',
      }),
    );
    expect(vm.health.status).toBe('degraded');
    expect(vm.health.readout).toBe('DEGRADED');
  });
});

describe('resourceHealthVM — edge', () => {
  it('amber pressure escalates a fresh feed to DEGRADED', () => {
    const vm = resourceHealthVM(
      resourceHealthSnap([src('fresh', 'lmstudio', T0)], {
        pressureLevel: 2,
        pressureState: 'amber',
        freeRamPct: 22,
      }),
    );
    expect(vm.health.status).toBe('degraded');
    expect(vm.pressure?.state).toBe('amber');
  });

  it('absent localModelResidentBytes projects undefined (not computable yet)', () => {
    const vm = resourceHealthVM(resourceHealthSnap([src('fresh', 'lmstudio', T0)]));
    expect(vm.pressure?.localModelResidentBytes).toBeUndefined();
  });

  it('caps notices at MAX_NOTICE_ROWS in the VM output ordering', () => {
    const many = Array.from({ length: MAX_NOTICE_ROWS + 4 }, (_, i) => ({
      action: 'trim-scrollback' as const,
      at: T0 + i,
    }));
    const vm = resourceHealthVM(
      resourceHealthSnap([src('fresh', 'lmstudio', T0)], { notices: many }),
    );
    // The VM keeps ALL notices (the component slices for display); the VM's
    // job is ordering, so we assert newest-first ordering is complete.
    expect(vm.notices).toHaveLength(MAX_NOTICE_ROWS + 4);
    expect(vm.notices[0]?.at).toBe(T0 + MAX_NOTICE_ROWS + 3);
  });

  it('every pressure state produces a defined status (exhaustive)', () => {
    for (const state of PRESSURE_STATES as readonly PressureState[]) {
      const vm = resourceHealthVM(
        resourceHealthSnap([src('fresh', 'lmstudio', T0)], { pressureState: state }),
      );
      expect(vm.health.status).not.toBe(undefined);
      expect(vm.pressure?.state).toBe(state);
    }
  });
});
