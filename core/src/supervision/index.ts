/**
 * core/src/supervision — the [X1] resource governor & supervision hardening
 * (BE-9; plan §4/BE-9, blueprint §11). Modules:
 *
 *   types.ts          the supervised-session registry entry + the two
 *                     injectable telemetry ports (footprint sampler, pressure
 *                     probe) + the blueprint §11 threshold tables
 *   watchdog.ts       per-session phys_footprint watchdog: per-class
 *                     warn/recycle + the opencode-serve sustained-window
 *                     debounce + hysteresis
 *   pressureProbe.ts  pressure-delta amber/red state machine (never naive free
 *                     RAM) + the guarded real macOS probe
 *   scheduler.ts      THE [X1] sacrifice order + account-never-victim +
 *                     account-spawn-post-shed admission
 *   hibernation.ts    idle hibernation (30 min; never account sessions)
 *   configMonitor.ts  ~/.claude.json size monitoring per account dir (read-only)
 *   governor.ts       the tick loop fusing all signals → actions + the frozen
 *                     resource-health snapshot; recycle rides BE-2's ptyHost
 *                     (the [X4] continuation mechanism)
 *   publisher.ts      resource-health snapshot → the events channel (validated)
 *
 * {@link createSupervisionSlice} assembles the compose-ready slice; the
 * composition root (core/src/main/) injects it exactly like the M4 workstream
 * and M5 pipeline slices (fake sampler/probe in tests, the real ones at
 * runtime behind their documented guards).
 */

import type { ResourceHealthSnapshot, SourceFreshness } from '@aibender/protocol';
import type { Logger } from '@aibender/shared';

import {
  createGovernor,
  type FrontendWeightPort,
  type Governor,
  type GovernorTickResult,
  type HibernatePort,
  type LocalModelPort,
  type RecyclePort,
} from './governor.js';
import { createResourceHealthPublisher, type ResourceHealthSink } from './publisher.js';
import type { SpawnAdmission } from './scheduler.js';
import type {
  FootprintSampler,
  FootprintThresholds,
  PressureProbe,
  PressureThresholds,
  WatchdogClass,
} from './types.js';

export type { WatchdogBand, WatchdogVerdict, FootprintWatchdog } from './watchdog.js';
export { createFootprintWatchdog } from './watchdog.js';
export type { PressureState, PressureVerdict, PressureMonitor } from './pressureProbe.js';
export { createPressureMonitor, createSpawnPressureProbe } from './pressureProbe.js';
export {
  SACRIFICE_ORDER,
  admitSpawn,
  planShed,
  type ShedAction,
  type ShedStep,
  type ShedPlanInput,
  type SpawnAdmission,
  type SpawnAdmissionInput,
} from './scheduler.js';
export {
  planIdleHibernation,
  type HibernationCandidate,
  type IdleHibernationInput,
} from './hibernation.js';
export {
  CLAUDE_CONFIG_FILE,
  DEFAULT_CONFIG_WARN_BYTES,
  createClaudeConfigMonitor,
  type ClaudeConfigMonitor,
  type ClaudeConfigMonitorOptions,
  type ClaudeConfigSize,
} from './configMonitor.js';
export {
  createGovernor,
  type Governor,
  type GovernorOptions,
  type GovernorTickResult,
  type RecyclePort,
  type LocalModelPort,
  type FrontendWeightPort,
  type HibernatePort,
} from './governor.js';
export {
  createResourceHealthPublisher,
  type ResourceHealthPublisher,
  type ResourceHealthSink,
} from './publisher.js';
export {
  DEFAULT_FOOTPRINT_THRESHOLDS,
  DEFAULT_PRESSURE_THRESHOLDS,
  DEFAULT_IDLE_HIBERNATION_MS,
  type FootprintSampler,
  type FootprintThresholds,
  type PressureProbe,
  type PressureReading,
  type PressureThresholds,
  type SupervisedSession,
  type WatchdogClass,
} from './types.js';

// ---------------------------------------------------------------------------
// Compose-ready slice (consumed by core/src/main/ — the BE-9 wiring seam)
// ---------------------------------------------------------------------------

export interface SupervisionSliceOptions {
  /** phys_footprint sampler (fake in tests; the guarded real reader at runtime). */
  readonly sampler: FootprintSampler;
  /** pressure-delta probe (fake in tests; createSpawnPressureProbe at runtime). */
  readonly probe: PressureProbe;
  /** The events-channel publish sink (composeBroker passes the gateway handle). */
  readonly sink?: ResourceHealthSink;
  /** BE-2 ptyHost recycle path (the [X4] continuation mechanism). */
  readonly recycle?: RecyclePort;
  /** BE-4 residency ledger evict/budget port. */
  readonly localModel?: LocalModelPort;
  readonly frontend?: FrontendWeightPort;
  readonly hibernate?: HibernatePort;
  readonly footprintThresholds?: Partial<Record<WatchdogClass, FootprintThresholds>>;
  readonly pressureThresholds?: Partial<PressureThresholds>;
  readonly hysteresisMb?: number;
  readonly idleWindowMs?: number;
  /** Freshness of the supervision feed on the snapshot. */
  readonly sources?: readonly SourceFreshness[];
  readonly logger?: Logger;
}

/** Everything core/src/main/ wires — one governor, one publisher, one slice. */
export interface SupervisionSlice {
  /** The governor (register/deregister/noteActivity/admitSpawnNow/tick). */
  readonly governor: Governor;
  /**
   * Run one supervision pass and PUBLISH the resulting snapshot (when a sink
   * was wired). Returns the tick result. This is the operator/timer entry
   * point (the composition root drives it on an interval); tests call it
   * directly. Never throws to the caller (a publish failure is logged; the
   * governor's own paths swallow their errors).
   */
  tickAndPublish(nowMs: number): Promise<GovernorTickResult>;
  /** The last-produced snapshot (for boot-snapshot publication). */
  snapshotOf(result: GovernorTickResult): ResourceHealthSnapshot;
}

export function createSupervisionSlice(options: SupervisionSliceOptions): SupervisionSlice {
  const governor = createGovernor({
    sampler: options.sampler,
    probe: options.probe,
    ...(options.recycle !== undefined ? { recycle: options.recycle } : {}),
    ...(options.localModel !== undefined ? { localModel: options.localModel } : {}),
    ...(options.frontend !== undefined ? { frontend: options.frontend } : {}),
    ...(options.hibernate !== undefined ? { hibernate: options.hibernate } : {}),
    ...(options.footprintThresholds !== undefined
      ? { footprintThresholds: options.footprintThresholds }
      : {}),
    ...(options.pressureThresholds !== undefined
      ? { pressureThresholds: options.pressureThresholds }
      : {}),
    ...(options.hysteresisMb !== undefined ? { hysteresisMb: options.hysteresisMb } : {}),
    ...(options.idleWindowMs !== undefined ? { idleWindowMs: options.idleWindowMs } : {}),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  const publisher =
    options.sink !== undefined ? createResourceHealthPublisher({ sink: options.sink }) : undefined;

  return {
    governor,
    tickAndPublish: async (nowMs) => {
      const result = await governor.tick(nowMs);
      if (publisher !== undefined) {
        try {
          publisher.publish(result.snapshot);
        } catch (cause) {
          options.logger?.error('resource-health publish failed (tick unaffected)', {
            detail: (cause as Error).message,
          });
        }
      }
      return result;
    },
    snapshotOf: (result) => result.snapshot,
  };
}

/** Re-export the admission decision type consumers key off. */
export type { SpawnAdmission as SupervisionSpawnAdmission };
