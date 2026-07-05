/**
 * Shared supervision & resource-governor surface (BE-9; plan §4/BE-9,
 * blueprint §11). The runtime registry entry, the two injectable telemetry
 * ports (footprint sampler, pressure probe), and the threshold configuration
 * every module keys off.
 *
 * [X2] — nothing in this module carries identity. A supervised session is
 * LABELS + numbers only: the placeholder account label, the frozen backend,
 * a per-account DISPLAY ordinal (`slot`, never a native id), and enough
 * BOOLEAN policy flags (isAccountSession, recyclable, hibernatable) to encode
 * the [X1] invariants. No native session id, no cwd, no title.
 *
 * The injected telemetry ports are the FAKE-in-tests seam (the whole package
 * is driven by a fake sampler/probe under vitest; the real macOS
 * phys_footprint / memory_pressure -Q readers are guarded runtime code in
 * sampler.ts / pressureProbe.ts). NO module here ever bloats a real process
 * or issues a cost-incurring call.
 */

import type { AccountLabel, Backend } from '@aibender/protocol';

// ---------------------------------------------------------------------------
// The supervised-session registry entry (labels + numbers only [X2])
// ---------------------------------------------------------------------------

/**
 * A backend as the WATCHDOG classifies it. `claude_code` and `lmstudio` map
 * 1:1 to the frozen {@link Backend} vocabulary; the OpenCode backend splits in
 * two because the two processes have DIFFERENT footprint thresholds
 * (blueprint §11 / §4.2): the per-session OpenCode agent (warn 1 GB / recycle
 * 1.5 GB) versus the single supervised `opencode serve` daemon (sustained
 * >500 MB for 5 min — a Bun GC sawtooth, matched on argv `serve`, NEVER on the
 * unrelated desktop app). The wire projection maps both back to `opencode`.
 */
export type WatchdogClass = 'claude' | 'opencode' | 'opencode-serve' | 'lmstudio';

/**
 * One live session the governor supervises. Registered/deregistered by the
 * composition root as sessions launch and settle; the governor never mints
 * these itself. Identity-free by construction [X2].
 */
export interface SupervisedSession {
  /**
   * The harness session id — the governor's own dedupe/registry key. It is a
   * harness id (never a native id, `ses_…`); it NEVER rides the wire (the wire
   * carries `slot`, a display ordinal). Kept off the snapshot so a snapshot is
   * pure labels + numbers.
   */
  readonly sessionId: string;
  readonly account: AccountLabel;
  readonly backend: Backend;
  /** How the footprint watchdog classifies this session's thresholds. */
  readonly watchdogClass: WatchdogClass;
  /** Per-account DISPLAY ordinal (0-based), assigned at registration [X2]. */
  readonly slot: number;
  /**
   * The [X1] hard invariant: a claude ACCOUNT session (MAX_A/MAX_B/ENT) is
   * NEVER the victim of a shed action and is NEVER auto-hibernated. Derived
   * from the account label at registration; the scheduler and hibernation
   * planner both consult it.
   */
  readonly isAccountSession: boolean;
}

// ---------------------------------------------------------------------------
// Injectable telemetry ports (the FAKE-in-tests seam)
// ---------------------------------------------------------------------------

/**
 * A single per-session phys_footprint reading, MB. Blueprint §11: macOS `ps
 * rss` is misleading — the truth is phys_footprint (via `footprint` / `vmmap`
 * / proc APIs). The port hides the platform reader so tests inject a FAKE
 * sampler; the sampler is asked for one session's footprint at a time so the
 * governor can drive it deterministically.
 */
export interface FootprintSampler {
  /**
   * phys_footprint for a live session, MB — or `undefined` when the reading is
   * unavailable (process gone / probe failed). NEVER throws (a sampler that
   * throws is a sampler bug; the governor treats a throw as `undefined`).
   */
  sampleMb(session: SupervisedSession): number | undefined;
}

/**
 * A pressure-delta health reading (blueprint §11): macOS memory-pressure LEVEL
 * (0..4 — the `memory_pressure -Q` / pressure notify axis), free physical RAM
 * percentage, swap bytes in use, and the pageout rate. Health signals are
 * pressure/swap DELTAS, NEVER naive free RAM — but free RAM % rides along as a
 * secondary threshold input (blueprint §11 amber `free <25%` / red `free
 * <12%`). The band derivation in pressureProbe.ts is the part that is a delta,
 * not this reading's shape.
 */
export interface PressureReading {
  /** macOS memory-pressure level, 0..4 (amber@2, red@4 — blueprint §11). */
  readonly pressureLevel: number;
  /** Free physical RAM, 0..100. */
  readonly freeRamPct: number;
  /** Swap in use, bytes (amber >20 GB, red >26 GB — blueprint §11). */
  readonly swapUsedBytes: number;
  /**
   * Pageout rate (pages/sec) — the DELTA signal (blueprint §11: "pageout
   * rates", never naive free RAM). A sustained non-zero pageout rate is the
   * strongest red indicator; the band logic weights it above raw free RAM.
   */
  readonly pageoutRate: number;
}

/**
 * The pressure-delta probe (blueprint §11: `memory_pressure -Q` + pressure
 * level + pageout rates). The FAKE-in-tests seam — the real reader lives in
 * pressureProbe.ts behind a runtime guard.
 */
export interface PressureProbe {
  /**
   * The current pressure reading — or `undefined` when the probe cannot read
   * (surfaces as a `no-signal` freshness state, never a fabricated zero).
   * NEVER throws.
   */
  read(): PressureReading | undefined;
}

// ---------------------------------------------------------------------------
// Thresholds (blueprint §11 numbers, all overridable config)
// ---------------------------------------------------------------------------

/** Per-class footprint warn/recycle lines, MB (blueprint §11). */
export interface FootprintThresholds {
  readonly warnMb: number;
  /**
   * The recycle line — `undefined` for `opencode-serve` (the serve daemon is
   * shed by the scheduler / restarted operationally, not per-session
   * recycled through the ptyHost continuation path).
   */
  readonly recycleMb?: number;
  /**
   * Sustained-window seconds a reading must STAY at/over `warnMb` before the
   * band flips to `warn` (GC-sawtooth debounce). 0 = instantaneous. Blueprint
   * §11 / §4.2: `opencode serve` trips only on SUSTAINED >500 MB for 5 min.
   */
  readonly sustainedSeconds: number;
}

/**
 * The blueprint §11 threshold table, per watchdog class. All MB. Values are
 * config (overridable); the STRUCTURE (per-class warn/recycle + sustained
 * window) is the contract.
 */
export const DEFAULT_FOOTPRINT_THRESHOLDS: Readonly<Record<WatchdogClass, FootprintThresholds>> =
  Object.freeze({
    // claude warn 3 GB / recycle 6 GB (instantaneous — no sawtooth on a TUI).
    claude: { warnMb: 3072, recycleMb: 6144, sustainedSeconds: 0 },
    // opencode agent warn 1 GB / recycle 1.5 GB.
    opencode: { warnMb: 1024, recycleMb: 1536, sustainedSeconds: 0 },
    // opencode serve: sustained >500 MB for 5 min (300 s) — Bun GC sawtooth.
    // No per-session recycle line (the daemon is scheduler-shed, not recycled).
    'opencode-serve': { warnMb: 500, sustainedSeconds: 300 },
    // LM Studio: it is the model host, not an agent session — a generous warn
    // line so the instrument surfaces a bloated runtime; the local-model
    // budget (residency.ts) is the real lever, shed FIRST in the sacrifice
    // order. No per-session recycle (the model is unloaded, not recycled).
    lmstudio: { warnMb: 8192, sustainedSeconds: 0 },
  });

/** Memory-pressure band thresholds (blueprint §11). Bytes for swap. */
export interface PressureThresholds {
  /** Amber: pressure level >= this OR free RAM < amberFreeRamPct OR swap > amberSwapBytes. */
  readonly amberLevel: number;
  readonly amberFreeRamPct: number;
  readonly amberSwapBytes: number;
  /** Red: pressure level >= this OR free RAM < redFreeRamPct OR swap > redSwapBytes. */
  readonly redLevel: number;
  readonly redFreeRamPct: number;
  readonly redSwapBytes: number;
  /**
   * A non-zero pageout rate at/over this (pages/sec) forces AT LEAST amber
   * regardless of free RAM (the DELTA signal dominates — blueprint §11 "never
   * naive free RAM"). A high sustained rate at/over `redPageoutRate` forces
   * red.
   */
  readonly amberPageoutRate: number;
  readonly redPageoutRate: number;
}

const GIB = 1024 * 1024 * 1024;

/** Blueprint §11 pressure thresholds: amber@(2 / <25% / >20 GB), red@(4 / <12% / >26 GB). */
export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = Object.freeze({
  amberLevel: 2,
  amberFreeRamPct: 25,
  amberSwapBytes: 20 * GIB,
  redLevel: 4,
  redFreeRamPct: 12,
  redSwapBytes: 26 * GIB,
  amberPageoutRate: 1,
  redPageoutRate: 1000,
});

/** Idle-hibernation window (blueprint §11: after 30 min). */
export const DEFAULT_IDLE_HIBERNATION_MS = 30 * 60 * 1000;
