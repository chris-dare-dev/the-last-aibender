/**
 * core/src/workstreams — the [X4] workstream ledger, briefs, reconciler and
 * guardrails (BE-7; plan §4/BE-7, blueprint §5). Modules:
 *
 *   wire.ts        store-row → frozen wire-record projections [X2]
 *   ledger.ts      workstream CRUD + §16.5 list/detail snapshots
 *   recorder.ts    THE LineageRecorder (ws-protocol.md §15.1) — action-time
 *                  nodes + edges over schema migration 0003
 *   briefs.ts      brief synthesis: native-summary reuse, qwen-produces /
 *                  Claude-reviews ports, deterministic conflict surfacing
 *   engine.ts      the gateway WorkstreamEnginePort — the frozen merge verb
 *   automation.ts  the WorkstreamHookRouting handlers (hooks-contract §7.1)
 *   reconciler.ts  external sessions → inferred-confidence orphans
 *   pressure.ts    the ~70% "branch now" advisory (ICR-0009 tap consumer)
 *   resolver.ts    the frozen SessionIdResolver (ws-protocol.md §15.2)
 *   guardrails.ts  unresumable flagging + retention monitoring counters
 *
 * {@link createWorkstreamSlice} assembles the compose-ready slice over ONE
 * LineageStore + ONE publisher; core/src/main/ injects it (the narrow
 * BE-7 wiring exceptions recorded there).
 */

import type { LineageRecorder, WorkstreamHookRouting, SessionIdResolver } from '@aibender/protocol';
import type { LineageStore, ResumeLedgerStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';

import type { ContinuationEdgeEmitter } from '../kernel/pty/ptyHost.js';
import {
  createWorkstreamHookAutomation,
  type WorkstreamHookAutomation,
} from './automation.js';
import type { BriefSynthesizer } from './briefs.js';
import { createWorkstreamEngine, type WorkstreamEngine } from './engine.js';
import { createWorkstreamGuardrails, type WorkstreamGuardrails } from './guardrails.js';
import { createWorkstreamLedger, type WorkstreamLedger } from './ledger.js';
import { createContextPressureWatch, type ContextPressureWatch } from './pressure.js';
import { createLineageRecorder, type LedgerLineageRecorder } from './recorder.js';
import { createSessionIdResolver } from './resolver.js';
import type { WorkstreamPublisher } from './wire.js';

export {
  edgeToWire,
  nodeToWire,
  summaryOfWorkstream,
  type WorkstreamPublisher,
} from './wire.js';
export {
  createWorkstreamLedger,
  type CreateWorkstreamInput,
  type WorkstreamLedger,
  type WorkstreamLedgerOptions,
} from './ledger.js';
export {
  createLineageRecorder,
  type LedgerLineageRecorder,
  type LedgerLineageRecorderStats,
  type LineageRecorderOptions,
} from './recorder.js';
export {
  BRIEF_DRAFT_SYSTEM_PROMPT,
  NATIVE_COMPACTION_SUMMARY_PREFIX,
  createBriefSynthesizer,
  extractClaims,
  extractNativeCompactionSummary,
  lmStudioBriefDrafter,
  renderConflictsSection,
  surfaceConflicts,
  type BranchDistillate,
  type BriefDraftRequest,
  type BriefDraftResult,
  type BriefDrafterPort,
  type BriefRefinerPort,
  type BriefSynthesizer,
  type BriefSynthesizerOptions,
  type LmStudioBriefDrafterOptions,
  type SurfacedConflict,
  type SynthesizedBrief,
} from './briefs.js';
export {
  createWorkstreamEngine,
  type WorkstreamEngine,
  type WorkstreamEngineOptions,
} from './engine.js';
export {
  createWorkstreamHookAutomation,
  type WorkstreamHookAutomation,
  type WorkstreamHookAutomationOptions,
  type WorkstreamHookAutomationStats,
} from './automation.js';
export {
  OPENCODE_SESSION_POLL_SQL,
  createWorkstreamReconciler,
  type ReconcilerAccountRoot,
  type ReconcilerCycleResult,
  type ReconcilerOpencodeDb,
  type ReconcilerOpencodeTarget,
  type ReconcilerStats,
  type ReconcilerWatchHandle,
  type WorkstreamReconciler,
  type WorkstreamReconcilerOptions,
} from './reconciler.js';
export {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_PRESSURE_THRESHOLD_PCT,
  DEFAULT_REARM_DELTA_PCT,
  createContextPressureWatch,
  extractUsageTokens,
  type ContextPressureStats,
  type ContextPressureWatch,
  type ContextPressureWatchOptions,
} from './pressure.js';
export {
  createSessionIdResolver,
  type SessionIdResolverOptions,
} from './resolver.js';
export {
  DEFAULT_RETENTION_WARN_DAYS,
  NATIVE_RETENTION_DAYS,
  createWorkstreamGuardrails,
  type RetentionCounters,
  type RetentionSweepResult,
  type WorkstreamGuardrails,
  type WorkstreamGuardrailsOptions,
} from './guardrails.js';

// ---------------------------------------------------------------------------
// Compose-ready slice (consumed by core/src/main/ — the BE-7 wiring seam)
// ---------------------------------------------------------------------------

/**
 * Adapt the M2 ptyHost `ContinuationEdgeEmitter` stub onto the frozen
 * {@link LineageRecorder} port (ws-protocol.md §15.1: "the composition root
 * adapts BE-2's ContinuationEdgeEmitter stub onto this port"). A recycle
 * continuation is the `recycle` action; same-node recycles carry
 * from === to.
 */
export function continuationEdgesFromRecorder(
  recorder: LineageRecorder,
): ContinuationEdgeEmitter {
  return {
    emitContinuationEdge: (event) => {
      recorder.record({
        kind: 'recycle',
        fromSessionId: event.fromSessionId,
        toSessionId: event.toSessionId,
        atEpochMs: event.atEpochMs,
      });
    },
  };
}

export interface WorkstreamSliceOptions {
  /** Migration 0003 accessors — the KERNEL database (sqlite-ddl.md §8.1). */
  readonly store: LineageStore;
  /** The SAME resume ledger the kernel writes (endpoint healing + dedupe). */
  readonly resumeLedger?: ResumeLedgerStore;
  /**
   * The gateway `publishWorkstream` binding. composeBroker passes a
   * late-bound closure (the gateway boots after the kernel); payloads
   * published before the gateway is up are dropped by that closure.
   */
  readonly publish?: WorkstreamPublisher;
  /** Brief synthesis ports (fakes in tests; LM Studio drafter at runtime). */
  readonly synthesizer?: BriefSynthesizer;
  /** READ-ONLY transcript reader override (tests inject fixtures). */
  readonly readTranscript?: (path: string) => string | undefined;
  /** Context-pressure tuning (threshold/window/hysteresis). */
  readonly pressure?: {
    readonly thresholdPct?: number;
    readonly rearmBelowPct?: number;
    readonly contextWindowTokens?: number;
  };
  /** Retention tuning (guardrails.ts). */
  readonly retention?: {
    readonly retentionDays?: number;
    readonly warnWindowDays?: number;
  };
  readonly logger?: Logger;
  readonly nowMs?: () => number;
}

/** Everything core/src/main/ wires — one store, one publisher, one slice. */
export interface WorkstreamSlice {
  /** Kernel/ptyHost edge port (ws-protocol.md §15.1). */
  readonly recorder: LedgerLineageRecorder;
  /** The ptyHost `edges` option, adapted from the recorder. */
  readonly continuationEdges: ContinuationEdgeEmitter;
  /** Workstream CRUD + §16.5 snapshot publication. */
  readonly ledger: WorkstreamLedger;
  /** The gateway `workstreams` port (merge verb). */
  readonly engine: WorkstreamEngine;
  /** The hooks-endpoint routing handlers (hooks-contract.md §7.1). */
  readonly automation: WorkstreamHookAutomation;
  /** The frozen native→harness resolver (ws-protocol.md §15.2). */
  readonly resolveSessionId: SessionIdResolver;
  /** The ~70% branch-now advisory watch (feed it raw tap messages). */
  readonly pressure: ContextPressureWatch;
  /** Retention sweep + counters. */
  readonly guardrails: WorkstreamGuardrails;
}

export function createWorkstreamSlice(options: WorkstreamSliceOptions): WorkstreamSlice {
  const shared = {
    store: options.store,
    ...(options.publish !== undefined ? { publish: options.publish } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };
  const briefShared = {
    ...(options.synthesizer !== undefined ? { synthesizer: options.synthesizer } : {}),
    ...(options.readTranscript !== undefined ? { readTranscript: options.readTranscript } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  };

  const recorder = createLineageRecorder({
    ...shared,
    ...(options.resumeLedger !== undefined ? { resumeLedger: options.resumeLedger } : {}),
  });
  const ledger = createWorkstreamLedger({
    ...shared,
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  const engine = createWorkstreamEngine({ ...shared, ...briefShared });
  const automation = createWorkstreamHookAutomation({ ...shared, ...briefShared });
  const pressure = createContextPressureWatch({
    ...(options.publish !== undefined ? { publish: options.publish } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    ...(options.pressure?.thresholdPct !== undefined
      ? { thresholdPct: options.pressure.thresholdPct }
      : {}),
    ...(options.pressure?.rearmBelowPct !== undefined
      ? { rearmBelowPct: options.pressure.rearmBelowPct }
      : {}),
    ...(options.pressure?.contextWindowTokens !== undefined
      ? { contextWindowTokens: options.pressure.contextWindowTokens }
      : {}),
  });
  const guardrails = createWorkstreamGuardrails({
    ...shared,
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    ...(options.retention?.retentionDays !== undefined
      ? { retentionDays: options.retention.retentionDays }
      : {}),
    ...(options.retention?.warnWindowDays !== undefined
      ? { warnWindowDays: options.retention.warnWindowDays }
      : {}),
  });
  const resolveSessionId = createSessionIdResolver({
    store: options.store,
    ...(options.resumeLedger !== undefined ? { resumeLedger: options.resumeLedger } : {}),
  });

  return {
    recorder,
    continuationEdges: continuationEdgesFromRecorder(recorder),
    ledger,
    engine,
    automation,
    resolveSessionId,
    pressure,
    guardrails,
  };
}

/** Re-export the routing port type consumers register (hooks endpoint). */
export type { WorkstreamHookRouting };
