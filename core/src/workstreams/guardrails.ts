/**
 * [X4] GUARDRAILS (BE-7; plan §4/BE-7 item 7, blueprint §5 guardrails):
 *
 *   - `unresumable` FLAGGING: the native CLI cleans transcripts up after
 *     ~30 days (and a `/cd` can strand a scope) — nodes whose backing
 *     transcript aged out of the native retention window are flagged
 *     `unresumable` so the lineage view never offers a resume the substrate
 *     cannot honor. The graph KEEPS the node — lineage history outlives
 *     native retention (that is the point of the harness ledger).
 *   - RETENTION MONITORING COUNTERS: how many nodes are inside the warn
 *     window (approaching native cleanup) and how many already flagged —
 *     the read-model attach point for a future dashboard lens.
 *
 * The un-forked double-resume block — the third blueprint §5 guardrail —
 * lives where it must: in the kernel FSM (BE-1, sessionKernel.ts) and the
 * schema state machine; this module deliberately does not duplicate it.
 *
 * READ-ONLY toward native stores [X4]: the sweep reads node rows and writes
 * ONLY harness lineage state; it never stats, touches, or deletes any
 * transcript file (fs is not imported here — architecture.spec.ts proves
 * it for the whole package).
 */

import type { LineageStore, SessionNodeRow } from '@aibender/schema';
import type { Logger } from '@aibender/shared';

import { nodeToWire, type WorkstreamPublisher } from './wire.js';

/** The native transcript-cleanup horizon (x4-workstreams; blueprint §5). */
export const NATIVE_RETENTION_DAYS = 30;

/** Nodes within this many days of the horizon count as "approaching". */
export const DEFAULT_RETENTION_WARN_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lineage states the sweep may flag (terminal/flagged states are left be). */
const SWEEPABLE_STATES = Object.freeze(['running', 'idle', 'completed', 'external'] as const);

export interface RetentionSweepResult {
  readonly scanned: number;
  readonly flaggedUnresumable: number;
  readonly approachingRetention: number;
}

export interface RetentionCounters {
  readonly totalNodes: number;
  readonly unresumable: number;
  readonly approachingRetention: number;
  readonly detached: number;
}

export interface WorkstreamGuardrails {
  /**
   * Flag nodes whose last observed activity (falling back to creation) is
   * older than the retention window as `unresumable`; publish each node
   * upsert. Idempotent — already-flagged nodes are skipped.
   */
  sweepRetention(): RetentionSweepResult;
  /** Monitoring counters over the current node population. */
  retentionCounters(): RetentionCounters;
}

export interface WorkstreamGuardrailsOptions {
  readonly store: LineageStore;
  readonly publish?: WorkstreamPublisher;
  /** Native cleanup horizon, days. Default 30. */
  readonly retentionDays?: number;
  /** Warn window before the horizon, days. Default 5. */
  readonly warnWindowDays?: number;
  readonly nowMs?: () => number;
  readonly logger?: Logger;
}

function lastActivityMs(node: SessionNodeRow): number {
  return node.lastActiveAtMs ?? node.createdAtMs;
}

export function createWorkstreamGuardrails(
  options: WorkstreamGuardrailsOptions,
): WorkstreamGuardrails {
  const { store } = options;
  const retentionDays = options.retentionDays ?? NATIVE_RETENTION_DAYS;
  const warnWindowDays = options.warnWindowDays ?? DEFAULT_RETENTION_WARN_DAYS;
  if (!(retentionDays > 0) || !(warnWindowDays >= 0) || warnWindowDays >= retentionDays) {
    throw new RangeError('retentionDays must exceed warnWindowDays (both positive)');
  }
  const nowMs = options.nowMs ?? Date.now;

  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      options.logger?.error('workstream publish refused a guardrail payload', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  const horizonMs = (): number => nowMs() - retentionDays * DAY_MS;
  const warnMs = (): number => nowMs() - (retentionDays - warnWindowDays) * DAY_MS;

  return {
    sweepRetention: () => {
      const horizon = horizonMs();
      const warn = warnMs();
      let scanned = 0;
      let flagged = 0;
      let approaching = 0;
      for (const node of store.nodes.list()) {
        scanned += 1;
        if (!(SWEEPABLE_STATES as readonly string[]).includes(node.state)) continue;
        const activity = lastActivityMs(node);
        if (activity <= horizon) {
          const updated = store.nodes.setState(node.id, 'unresumable');
          flagged += 1;
          publish({ kind: 'workstream-node', ...nodeToWire(updated) });
        } else if (activity <= warn) {
          approaching += 1;
        }
      }
      return { scanned, flaggedUnresumable: flagged, approachingRetention: approaching };
    },

    retentionCounters: () => {
      const warn = warnMs();
      const horizon = horizonMs();
      let unresumable = 0;
      let approaching = 0;
      let detached = 0;
      let total = 0;
      for (const node of store.nodes.list()) {
        total += 1;
        if (node.workstreamId === null) detached += 1;
        if (node.state === 'unresumable') {
          unresumable += 1;
          continue;
        }
        const activity = lastActivityMs(node);
        if (
          (SWEEPABLE_STATES as readonly string[]).includes(node.state) &&
          activity <= warn &&
          activity > horizon
        ) {
          approaching += 1;
        }
      }
      return {
        totalNodes: total,
        unresumable,
        approachingRetention: approaching,
        detached,
      };
    },
  };
}
