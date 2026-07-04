/**
 * OpenCode /global/event consumption VIA BE-4's SSE transport (BE-5 source
 * 4; plan §4/BE-5: "consumption with strict `evt_`-id dedupe, `sync` wrapper
 * dropping after watermark capture, unknown-event tolerance" — the transport
 * (core/src/adapters/opencode/sse.ts) already implements the wire half; this
 * source CONSUMES it, never re-implements transport).
 *
 * Dedupe layers (strict, plan §9.2 BE-5 positive row):
 *   1. transport: bounded `evt_`-id window (reconnect replays deduped);
 *   2. store: UNIQUE (backend='opencode', raw_ref=`evt_` id) — total across
 *      restarts AND against the opencode.db scrape (identical ids).
 *
 * GAP REPAIR (plan §9.2 BE-5 edge "SSE gap → after=<seq> replay heals
 * exactly"): while events flow, the source snapshots the transport's sync
 * watermarks (the durable store's seq per session, captured from the sync
 * wrappers the transport absorbs). After a disconnect, missed events are
 * gone from /global/event forever — `repairGaps()` replays each session's
 * durable stream `after=<healed seq>` and ingests the missed slots under
 * replay-stable `oc-durable:` raw_refs.
 *
 * At-least-once note (HARDENED at M3 stewarding — the BE-5 return's ICR to
 * BE-4): the transport now fans the sync-wrapper correlation (`evt_` id ↔
 * durable (aggregate, seq) slot) out through `transport.onSync`. This source
 * subscribes and marks a durable slot HEALED the moment (a) its sync twin is
 * parsed AND (b) the correlated plain twin has been ingested — in either
 * arrival order (a bounded pending map covers sync-before-plain). Live rows
 * KEEP the `evt_` raw_ref (the opencode.db scrape reconciles on identical
 * ids — re-keying live rows onto `oc-durable:` refs would break that); the
 * durable-slot keying rides the healed-watermark axis instead, so a repair
 * replay never re-delivers a slot whose live twin this process already
 * ingested. Residual window: a crash BETWEEN plain-twin ingest and sync-twin
 * parse (one TCP chunk wide) still re-delivers across restarts — the store
 * keeps both rows (different raw_ref namespaces), the documented tradeoff.
 */

import type { AccountLabel } from '@aibender/protocol';
import type { EventsTableStore } from '@aibender/schema';

import type { OpencodeSseTransport } from '../../adapters/opencode/sse.js';
import {
  assertOpencodeLabel,
  normalizeDurableOpencodeEvent,
  normalizeLiveOpencodeEvent,
} from './normalize.js';

export interface OpencodeSseCollectorStats {
  readonly liveRowsInserted: number;
  readonly liveRowsDeduped: number;
  readonly ignoredEvents: number;
  readonly repairedRowsInserted: number;
  readonly repairedRowsDeduped: number;
}

export interface OpencodeSseCollector {
  /** Consume the transport's single-consumer stream until close(). */
  start(): Promise<void>;
  /**
   * Replay EVERY known session's durable stream `after=<healed seq>` and
   * ingest missed slots. Unconditional per session — a disconnect can hide
   * BOTH twins of an event (plain and sync), so the local watermark cannot
   * prove absence of a gap; an already-caught-up replay is an empty stream
   * and costs one request. Returns rows inserted.
   */
  repairGaps(): Promise<number>;
  /** Replay ONE session after an explicit seq (tests drive this directly). */
  repairSession(sessionId: string, afterSeq: number): Promise<number>;
  /** Highest durable seq considered healed per session. */
  healedSeq(sessionId: string): number | undefined;
  stats(): OpencodeSseCollectorStats;
  close(): void;
}

export interface OpencodeSseCollectorOptions {
  readonly transport: OpencodeSseTransport;
  readonly events: EventsTableStore;
  /** The one opencode label (AWS_DEV) — composition-supplied [X2]. */
  readonly account: AccountLabel;
  readonly nowMs?: () => number;
}

export function createOpencodeSseCollector(
  options: OpencodeSseCollectorOptions,
): OpencodeSseCollector {
  assertOpencodeLabel(options.account);
  const nowMs = options.nowMs ?? Date.now;
  const { transport, events, account } = options;

  const healed = new Map<string, number>();
  /** Sessions observed on any path (live rows, watermarks, repairs). */
  const knownSessions = new Set<string>();
  const stats = {
    liveRowsInserted: 0,
    liveRowsDeduped: 0,
    ignoredEvents: 0,
    repairedRowsInserted: 0,
    repairedRowsDeduped: 0,
  };
  let closed = false;

  const advanceHealed = (sessionId: string, seq: number): void => {
    knownSessions.add(sessionId);
    const current = healed.get(sessionId);
    if (current === undefined || seq > current) healed.set(sessionId, seq);
  };

  const snapshotWatermarks = (): void => {
    for (const [sessionId, seq] of transport.watermarks()) {
      advanceHealed(sessionId, seq);
    }
  };

  // -- sync-correlation window closer (module doc "HARDENED at M3") ----------
  // Bounded working sets: evt_ ids this process ingested, and correlations
  // whose plain twin has not arrived yet. 4096 matches the transport's
  // dedupe window — the correlation horizon can never exceed the dedupe one.
  const CORRELATION_WINDOW = 4096;
  const ingestedLiveIds = new Set<string>();
  const pendingSyncByEventId = new Map<string, { sessionId: string; seq: number }>();
  const evictIfFull = <T>(set: Set<T> | Map<T, unknown>): void => {
    if (set.size >= CORRELATION_WINDOW) {
      const oldest = set.keys().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  };

  const onLiveIdIngested = (eventId: string): void => {
    const pending = pendingSyncByEventId.get(eventId);
    if (pending !== undefined) {
      pendingSyncByEventId.delete(eventId);
      advanceHealed(pending.sessionId, pending.seq);
      return;
    }
    evictIfFull(ingestedLiveIds);
    ingestedLiveIds.add(eventId);
  };

  const onSyncCorrelation = (correlation: {
    readonly aggregateId: string;
    readonly seq: number;
    readonly eventId?: string;
  }): void => {
    knownSessions.add(correlation.aggregateId);
    if (correlation.eventId === undefined) return;
    if (ingestedLiveIds.delete(correlation.eventId)) {
      // Plain twin already ingested → the slot is covered NOW.
      advanceHealed(correlation.aggregateId, correlation.seq);
      return;
    }
    evictIfFull(pendingSyncByEventId);
    pendingSyncByEventId.set(correlation.eventId, {
      sessionId: correlation.aggregateId,
      seq: correlation.seq,
    });
  };

  const repairSession = async (sessionId: string, afterSeq: number): Promise<number> => {
    knownSessions.add(sessionId);
    let inserted = 0;
    let highest = afterSeq;
    for await (const durable of transport.replaySession(sessionId, afterSeq)) {
      const seq = durable.seq;
      if (seq === undefined) continue; // no slot → cannot key a row honestly
      const row = normalizeDurableOpencodeEvent({
        account,
        sessionId,
        seq,
        payload: durable.payload,
        fallbackTsMs: nowMs(),
      });
      const outcome = events.insert(row);
      if (outcome.inserted) {
        stats.repairedRowsInserted += 1;
        inserted += 1;
      } else {
        stats.repairedRowsDeduped += 1;
      }
      if (seq > highest) highest = seq;
    }
    const current = healed.get(sessionId);
    if (current === undefined || highest > current) healed.set(sessionId, highest);
    return inserted;
  };

  return {
    start: async () => {
      const unsubscribeSync = transport.onSync(onSyncCorrelation);
      try {
        for await (const event of transport.events()) {
          if (closed) break;
          const outcome = normalizeLiveOpencodeEvent({
            account,
            id: event.id,
            type: event.type,
            properties: event.properties,
            fallbackTsMs: nowMs(),
          });
          if (outcome.kind === 'ignored') {
            stats.ignoredEvents += 1; // unknown SSE event: silent (plan §9.2)
          } else {
            const insert = events.insert(outcome.row);
            if (insert.inserted) stats.liveRowsInserted += 1;
            else stats.liveRowsDeduped += 1;
            if (outcome.row.nativeSessionId !== undefined) {
              knownSessions.add(outcome.row.nativeSessionId);
            }
            // Row present in the store (fresh insert OR dedupe) → its
            // durable slot is covered once the sync twin correlates.
            onLiveIdIngested(event.id);
          }
          // We were demonstrably connected for this event — everything up to
          // the transport's current durable watermark is covered.
          snapshotWatermarks();
        }
      } finally {
        unsubscribeSync();
      }
    },

    repairGaps: async () => {
      snapshotWatermarks(); // pick up sessions seen only via sync wrappers
      let inserted = 0;
      for (const sessionId of [...knownSessions]) {
        inserted += await repairSession(sessionId, healed.get(sessionId) ?? -1);
      }
      return inserted;
    },

    repairSession,
    healedSeq: (sessionId) => healed.get(sessionId),
    stats: () => ({ ...stats }),
    close: () => {
      closed = true;
    },
  };
}
