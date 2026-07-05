/**
 * CONTEXT-PRESSURE WATCH (BE-7; plan §4/BE-7 item 5, blueprint §5 handoff
 * automation: "context-pressure watch proposes 'branch now' at ~70%").
 *
 * Input: the per-session RAW SDK message stream — the ICR-0009 kernel
 * message tap axis. The composition root feeds `observe(sessionId, raw)`
 * from the same tee that feeds the gateway's transcript projector
 * (`rawOfRunnerMessage`), so the watch sees every assistant/result message
 * in stream order with zero extra consumers on the runner seam.
 *
 * Pressure math: the four ground-truth token classes (blueprint §6.2) summed
 * — input + output + cache-read + cache-creation — over the configured
 * context window. Both SDK snake_case (`input_tokens`, …) and the narrowed
 * camelCase (`inputTokens`, …) spellings are accepted; messages without a
 * usage block are ignored (the watch never guesses).
 *
 * Output: the FROZEN `branch-advisory` payload (ws-protocol.md §16.1) —
 * `contextUsedPct` clamped to 0..100 (the honesty-pin rule). The ~70%
 * THRESHOLD is broker configuration; the EVENT is the contract.
 *
 * HYSTERESIS (the frozen "fires once" rule): one advisory per upward
 * crossing. After firing, the session re-arms only when pressure falls back
 * below `rearmBelowPct` (compaction/fork dropped the context) — a session
 * hovering at 71–99% never re-fires.
 *
 * `observe` never throws (tap discipline, ICR-0009).
 */

import type { BranchAdvisory } from '@aibender/protocol';
import type { Logger } from '@aibender/shared';

import type { WorkstreamPublisher } from './wire.js';

/** Default context window (tokens) the pct is computed against. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** The blueprint §5 "~70%" default threshold. */
export const DEFAULT_PRESSURE_THRESHOLD_PCT = 70;

/** Default re-arm level: threshold minus this many points. */
export const DEFAULT_REARM_DELTA_PCT = 10;

export interface ContextPressureWatchOptions {
  /** The gateway `publishWorkstream` binding (advisories ride it). */
  readonly publish?: WorkstreamPublisher;
  /** Advisory threshold, percent (0 < t <= 100). Default 70. */
  readonly thresholdPct?: number;
  /** Re-arm when pressure falls below this. Default `thresholdPct - 10`. */
  readonly rearmBelowPct?: number;
  /** Context window the pct is computed against. Default 200k tokens. */
  readonly contextWindowTokens?: number;
  readonly nowMs?: () => number;
  readonly logger?: Logger;
}

export interface ContextPressureStats {
  readonly advisoriesFired: number;
  readonly messagesObserved: number;
}

export interface ContextPressureWatch {
  /** Observe one RAW SDK message for a session. NEVER throws. */
  observe(sessionId: string, raw: unknown): void;
  /** Last computed pressure (percent) for a session, if any. */
  pressureOf(sessionId: string): number | undefined;
  /** Drop per-session state (session ended / recycled). */
  forget(sessionId: string): void;
  stats(): ContextPressureStats;
}

interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

function tokenField(usage: Record<string, unknown>, ...names: readonly string[]): number {
  for (const name of names) {
    const value = usage[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Extract the four token classes from a raw SDK message, or undefined when
 * the message carries no usage block. Total over unknown shapes.
 */
export function extractUsageTokens(raw: unknown): UsageTokens | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  // Result messages carry `usage` at the top level; assistant messages nest
  // it under `message.usage` (the transcript projector's unwrap order).
  let usage: unknown = record['usage'];
  if (usage === undefined) {
    const message = record['message'];
    if (typeof message === 'object' && message !== null) {
      usage = (message as Record<string, unknown>)['usage'];
    }
  }
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const tokens: UsageTokens = {
    input: tokenField(u, 'input_tokens', 'inputTokens'),
    output: tokenField(u, 'output_tokens', 'outputTokens'),
    cacheRead: tokenField(u, 'cache_read_input_tokens', 'cacheReadTokens'),
    cacheCreation: tokenField(u, 'cache_creation_input_tokens', 'cacheCreationTokens'),
  };
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation === 0) {
    return undefined; // an all-zero block carries no signal
  }
  return tokens;
}

export function createContextPressureWatch(
  options: ContextPressureWatchOptions = {},
): ContextPressureWatch {
  const thresholdPct = options.thresholdPct ?? DEFAULT_PRESSURE_THRESHOLD_PCT;
  if (!(thresholdPct > 0 && thresholdPct <= 100)) {
    throw new RangeError('thresholdPct must be in (0, 100]');
  }
  const rearmBelowPct = options.rearmBelowPct ?? Math.max(0, thresholdPct - DEFAULT_REARM_DELTA_PCT);
  if (!(rearmBelowPct >= 0 && rearmBelowPct <= thresholdPct)) {
    throw new RangeError('rearmBelowPct must be in [0, thresholdPct]');
  }
  const windowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (!(Number.isFinite(windowTokens) && windowTokens > 0)) {
    throw new RangeError('contextWindowTokens must be a positive number');
  }
  const nowMs = options.nowMs ?? Date.now;

  const sessions = new Map<string, { pct: number; armed: boolean }>();
  const stats = { advisoriesFired: 0, messagesObserved: 0 };

  return {
    observe: (sessionId, raw) => {
      try {
        stats.messagesObserved += 1;
        const usage = extractUsageTokens(raw);
        if (usage === undefined) return;
        const used = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
        // Clamped 0..100 (the frozen honesty pin on contextUsedPct).
        const pct = Math.min(100, Math.max(0, (used / windowTokens) * 100));
        const state = sessions.get(sessionId) ?? { pct, armed: true };
        state.pct = pct;
        if (state.armed && pct >= thresholdPct) {
          state.armed = false; // fires ONCE per crossing (hysteresis)
          stats.advisoriesFired += 1;
          const advisory: BranchAdvisory = {
            kind: 'branch-advisory',
            sessionId,
            contextUsedPct: Math.round(pct * 10) / 10,
            ts: nowMs(),
          };
          try {
            options.publish?.(advisory);
          } catch (cause) {
            options.logger?.error('workstream publish refused a branch advisory', {
              sessionId,
              detail: (cause as Error).message,
            });
          }
        } else if (!state.armed && pct < rearmBelowPct) {
          state.armed = true; // context dropped (compaction/fork) — re-arm
        }
        sessions.set(sessionId, state);
      } catch (cause) {
        // Tap discipline: an observer must never break the pump.
        options.logger?.warn('context-pressure observe failed (swallowed)', {
          sessionId,
          detail: (cause as Error).message,
        });
      }
    },

    pressureOf: (sessionId) => sessions.get(sessionId)?.pct,

    forget: (sessionId) => {
      sessions.delete(sessionId);
    },

    stats: () => ({ ...stats }),
  };
}
