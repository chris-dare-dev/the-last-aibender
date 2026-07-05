/**
 * THE RECONCILER (BE-7; plan §4/BE-7 item 4, blueprint §5 recording
 * discipline): externally created sessions — launched outside the harness —
 * are registered as INFERRED-confidence orphans in the detached-HEAD bucket
 * within one cycle. Two feeds, exactly the blueprint matrix:
 *
 *   - fs-watch over each account's `projects/**` transcript tree (the
 *     Claude Code layout: `<projectsDir>/<encoded-cwd>/<native-uuid>.jsonl`).
 *     Tests point the roots at FIXTURE/TEMP dirs only — the real account
 *     config dirs are wired at runtime by operator config, never here.
 *   - read-only `opencode.db` polling through BE-4's guarded handle
 *     (openOpencodeDbReadOnly — the [X2] statement screen refuses the
 *     `account`/`credential` tables fail-closed; this module issues ONE
 *     SELECT over the durable `event` table).
 *
 * SINGLE-WRITER DISCIPLINE (the frozen §15.1 rule): the reconciler covers
 * EXTERNAL sessions ONLY and never rides the LineageRecorder port —
 * kernel-driven sessions are deduped out on their native id (resume ledger +
 * `session_node.byNativeSessionId`), and the reconciler NEVER creates edges:
 * a reconciled orphan has no in-graph parent the harness could assert
 * (edges would be guesses; `confidence: 'inferred'` NODES are the honest
 * claim). Native first-class lineage columns (opencode `parent_id`) are a
 * later lens — out of the M4 slice.
 *
 * `/cd` HANDLING (plan §9.2 BE-7 edge row): a known native id observed
 * under a NEW encoded-cwd is the `/cd` move — the node's MUTABLE
 * `native_scope` is updated in place; identity, edges and workstream
 * assignment are untouched (lineage survives the move).
 *
 * [X4] HARD RULE — NO WRITE PATH TO NATIVE STORES: this module imports only
 * `readdirSync`/`statSync`/`watch` from node:fs and SELECTs through the
 * guarded read-only db handle. architecture.spec.ts proves the absence of
 * write-capable fs calls for the whole package; the fs-audit test proves
 * zero mutations of the watched trees + opencode.db under a full exercise.
 */

import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabelOrUndefined } from '@aibender/protocol';
import type { LineageStore, ResumeLedgerStore, SessionNodeRow } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import { nodeToWire, type WorkstreamPublisher } from './wire.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReconcilerAccountRoot {
  /** A Claude account (any MAX_<X> or ENT) — claude_code only (pairing-validated). */
  readonly accountLabel: AccountLabel;
  /**
   * ABSOLUTE path of the account's `projects/` tree. Tests pass fixture/temp
   * dirs ONLY; the real `~/.aibender/accounts/<label>/projects` paths are
   * operator runtime configuration.
   */
  readonly projectsDir: string;
}

/**
 * The read-only opencode.db polling target. Structurally BE-4's
 * `GuardedOpencodeDb` — the ONLY db access path this module accepts [X2/X4].
 */
export interface ReconcilerOpencodeDb {
  select(sql: string, params?: readonly unknown[]): readonly Record<string, unknown>[];
}

export interface ReconcilerOpencodeTarget {
  readonly db: ReconcilerOpencodeDb;
  /** AWS_DEV — the opencode pairing (validated). */
  readonly accountLabel: AccountLabel;
}

export interface WorkstreamReconcilerOptions {
  readonly store: LineageStore;
  /**
   * Kernel-dedupe source: native ids the harness spawned itself. The SAME
   * resume ledger the kernel writes.
   */
  readonly resumeLedger?: ResumeLedgerStore;
  readonly roots?: readonly ReconcilerAccountRoot[];
  readonly opencode?: ReconcilerOpencodeTarget;
  readonly publish?: WorkstreamPublisher;
  readonly logger?: Logger;
  /** Reconciled-node id factory (harness-minted, same charset). */
  readonly newNodeId?: () => string;
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export interface ReconcilerCycleResult {
  /** Native session ids observed this cycle (both feeds). */
  readonly observed: number;
  /** New inferred-confidence orphans registered into the detached bucket. */
  readonly registered: number;
  /** Skipped: kernel-driven (resume ledger) or already registered. */
  readonly deduped: number;
  /** `/cd` moves: native_scope updated on an existing node. */
  readonly scopeMoves: number;
}

export interface ReconcilerStats {
  readonly cycles: number;
  readonly registered: number;
  readonly deduped: number;
  readonly scopeMoves: number;
  readonly rootErrors: number;
}

export interface ReconcilerWatchHandle {
  close(): void;
}

export interface WorkstreamReconciler {
  /** One full scan of every configured feed. Never throws. */
  runCycle(): ReconcilerCycleResult;
  /**
   * Start continuous reconciliation: fs-watch on each projects tree (change
   * → debounced cycle) plus interval polling (covers opencode.db and any
   * watcher miss). Watchers are read-only and non-persistent.
   */
  start(options?: {
    readonly intervalMs?: number;
    readonly debounceMs?: number;
  }): ReconcilerWatchHandle;
  stats(): ReconcilerStats;
}

/** The ONE SELECT the opencode poll issues (screened by the BE-4 guard). */
export const OPENCODE_SESSION_POLL_SQL =
  "SELECT DISTINCT aggregate_id FROM event WHERE type LIKE 'session.%' ORDER BY aggregate_id";

export function createWorkstreamReconciler(
  options: WorkstreamReconcilerOptions,
): WorkstreamReconciler {
  const { store } = options;
  const logger = options.logger;
  const mintNodeId = options.newNodeId ?? (() => newId('ses'));

  for (const root of options.roots ?? []) {
    // ICR-0013: the Claude-account label form is OPEN — gate on the pairing
    // (any MAX_<X>/ENT → claude_code), never a hardcoded 3-set, so MAX_C/MAX_D
    // roots reconcile with no code change.
    if (backendForLabelOrUndefined(root.accountLabel) !== 'claude_code') {
      throw new RangeError(
        `reconciler roots are claude_code accounts (a MAX_<X> or ENT label); got ${root.accountLabel}`,
      );
    }
  }
  if (
    options.opencode !== undefined &&
    backendForLabelOrUndefined(options.opencode.accountLabel) !== 'opencode'
  ) {
    throw new RangeError('the opencode poll target must carry the AWS_DEV label');
  }

  const stats = { cycles: 0, registered: 0, deduped: 0, scopeMoves: 0, rootErrors: 0 };

  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      logger?.error('workstream publish refused a reconciler payload', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  /** True when the harness itself spawned this native session (dedupe). */
  const isKernelDriven = (nativeSessionId: string): boolean =>
    options.resumeLedger !== undefined &&
    options.resumeLedger.list().some((row) => row.nativeSessionId === nativeSessionId);

  interface Observation {
    readonly nativeSessionId: string;
    readonly accountLabel: AccountLabel;
    readonly backend: 'claude_code' | 'opencode';
    /** Encoded-cwd (claude) / project id (opencode) — the MUTABLE scope. */
    readonly nativeScope?: string;
    readonly transcriptRef?: string;
  }

  const reconcileOne = (
    observation: Observation,
    counters: { registered: number; deduped: number; scopeMoves: number },
  ): void => {
    const existing: SessionNodeRow | undefined = store.nodes.byNativeSessionId(
      observation.nativeSessionId,
    );
    if (existing !== undefined) {
      // Known node. A new scope for the same native id is the /cd move —
      // native_scope is MUTABLE; identity + edges + assignment stay put.
      if (
        observation.nativeScope !== undefined &&
        existing.nativeScope !== null &&
        existing.nativeScope !== observation.nativeScope
      ) {
        const moved = store.nodes.updateNativeScope(existing.id, observation.nativeScope);
        counters.scopeMoves += 1;
        publish({ kind: 'workstream-node', ...nodeToWire(moved) });
        return;
      }
      counters.deduped += 1;
      return;
    }
    if (isKernelDriven(observation.nativeSessionId)) {
      // Kernel-driven session whose lineage node the recorder owns — the
      // reconciler NEVER writes nodes or edges for these (single-writer).
      counters.deduped += 1;
      return;
    }
    const node = store.nodes.insert({
      id: mintNodeId(),
      backend: observation.backend,
      account: observation.accountLabel,
      nativeSessionId: observation.nativeSessionId,
      ...(observation.nativeScope !== undefined ? { nativeScope: observation.nativeScope } : {}),
      ...(observation.transcriptRef !== undefined
        ? { transcriptRef: observation.transcriptRef }
        : {}),
      state: 'external',
      origin: 'reconciled',
      confidence: 'inferred',
      // No workstreamId: the detached-HEAD bucket, by definition.
    });
    counters.registered += 1;
    publish({ kind: 'workstream-node', ...nodeToWire(node) });
  };

  /** Scan one projects tree: <projectsDir>/<encoded-cwd>/<uuid>.jsonl. */
  const observeClaudeRoot = (root: ReconcilerAccountRoot): Observation[] => {
    const observations: Observation[] = [];
    let scopes: readonly string[];
    try {
      scopes = readdirSync(root.projectsDir);
    } catch {
      stats.rootErrors += 1; // absent tree = nothing external yet, not an error
      return observations;
    }
    for (const scope of scopes) {
      const scopeDir = join(root.projectsDir, scope);
      let entries: readonly string[];
      try {
        if (!statSync(scopeDir).isDirectory()) continue;
        entries = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        observations.push({
          nativeSessionId: entry.slice(0, -'.jsonl'.length),
          accountLabel: root.accountLabel,
          backend: 'claude_code',
          nativeScope: scope,
          transcriptRef: join(scopeDir, entry),
        });
      }
    }
    return observations;
  };

  const observeOpencode = (): Observation[] => {
    const target = options.opencode;
    if (target === undefined) return [];
    let rows: readonly Record<string, unknown>[];
    try {
      rows = target.db.select(OPENCODE_SESSION_POLL_SQL);
    } catch (cause) {
      stats.rootErrors += 1;
      logger?.warn('opencode.db poll failed (skipped this cycle)', {
        detail: (cause as Error).message,
      });
      return [];
    }
    const observations: Observation[] = [];
    for (const row of rows) {
      const aggregateId = row['aggregate_id'];
      if (typeof aggregateId !== 'string' || aggregateId.length === 0) continue;
      observations.push({
        nativeSessionId: aggregateId,
        accountLabel: target.accountLabel,
        backend: 'opencode',
      });
    }
    return observations;
  };

  const runCycle = (): ReconcilerCycleResult => {
    const counters = { registered: 0, deduped: 0, scopeMoves: 0 };
    let observed = 0;
    try {
      const observations = [
        ...(options.roots ?? []).flatMap(observeClaudeRoot),
        ...observeOpencode(),
      ];
      observed = observations.length;
      for (const observation of observations) {
        try {
          reconcileOne(observation, counters);
        } catch (cause) {
          logger?.warn('reconciler skipped one observation', {
            detail: (cause as Error).message,
          });
        }
      }
    } catch (cause) {
      logger?.error('reconciler cycle failed (swallowed)', {
        detail: (cause as Error).message,
      });
    }
    stats.cycles += 1;
    stats.registered += counters.registered;
    stats.deduped += counters.deduped;
    stats.scopeMoves += counters.scopeMoves;
    return { observed, ...counters };
  };

  return {
    runCycle,

    start: (startOptions) => {
      const intervalMs = startOptions?.intervalMs ?? 15_000;
      const debounceMs = startOptions?.debounceMs ?? 250;
      const watchers: FSWatcher[] = [];
      let debounce: NodeJS.Timeout | undefined;
      let closed = false;

      const trigger = (): void => {
        if (closed) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          runCycle();
        }, debounceMs);
        debounce.unref?.();
      };

      for (const root of options.roots ?? []) {
        try {
          // READ-ONLY notification stream; recursive covers projects/**.
          const watcher = watch(root.projectsDir, { persistent: false, recursive: true }, () => {
            trigger();
          });
          watcher.on('error', () => {
            /* a vanished tree stops notifying; polling still covers it */
          });
          watchers.push(watcher);
        } catch {
          stats.rootErrors += 1; // tree may appear later; polling covers it
        }
      }

      const interval = setInterval(() => {
        runCycle();
      }, intervalMs);
      interval.unref?.();

      runCycle(); // the "within one cycle" guarantee starts NOW

      return {
        close: () => {
          closed = true;
          clearTimeout(debounce);
          clearInterval(interval);
          for (const watcher of watchers) watcher.close();
        },
      };
    },

    stats: () => ({ ...stats }),
  };
}
