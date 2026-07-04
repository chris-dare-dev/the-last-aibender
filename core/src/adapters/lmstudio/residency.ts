/**
 * JIT + TTL residency policy engine (BE-4; blueprint §4.3 "Residency
 * policy"; findings local-resource-feasibility.md §3/§5).
 *
 * Rules encoded here:
 *   - JIT load + per-request TTL: 1800 s nominal, 900 s under amber (or
 *     worse) memory pressure. The TTL timer resets on each request.
 *   - Default model cap: ≤8B params at ≤4-bit quant (Q4/MLX-4bit class),
 *     ctx budget governed upstream. 12–14B is OPT-IN only, and only while
 *     ≤6 agent sessions are resident. >14B is always refused.
 *   - ONE GLOBAL "local model resident" budget line across LM Studio AND
 *     Ollama — the ledger tracks residents of both servers; a load that
 *     would exceed the budget first proposes evicting idle residents
 *     (oldest-idle first), else is denied.
 *   - Unloads are VERIFIED via the API (known auto-evict-bypass bugs:
 *     lmstudio-bug-tracker #2051/#634) — see lifecycle.ts `verifyUnload`;
 *     the ledger only drops an entry on `markUnloaded`.
 *
 * Pure decision logic + an in-memory ledger; no I/O. BE-9's governor feeds
 * the pressure state; the LM Studio client feeds request touches.
 */

import { ResidencyDeniedError } from '../errors.js';

// ---------------------------------------------------------------------------
// TTL policy
// ---------------------------------------------------------------------------

export type PressureState = 'nominal' | 'amber' | 'red';

export const DEFAULT_TTL_SECONDS = 1800;
export const AMBER_TTL_SECONDS = 900;

/** TTL for a JIT load / request touch under the given memory pressure. */
export function ttlForPressure(pressure: PressureState): number {
  return pressure === 'nominal' ? DEFAULT_TTL_SECONDS : AMBER_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// Model specs and load evaluation
// ---------------------------------------------------------------------------

export type LocalModelServer = 'lmstudio' | 'ollama';

export interface LocalModelSpec {
  /** Server-native model key (e.g. `qwen3-8b-mlx`). */
  readonly key: string;
  readonly server: LocalModelServer;
  /** Parameter count in billions (8 for an 8B). */
  readonly paramsB: number;
  /** Quantization bit-width class (4 for Q4/MLX-4bit, 8 for Q8, 16 fp16). */
  readonly quantBits: number;
  /** Expected resident footprint incl. runtime buffers, GB. */
  readonly estimatedResidentGb: number;
}

export interface ResidencyPolicyOptions {
  /** Global resident budget across ALL local servers, GB. Default 12. */
  readonly budgetGb?: number;
  /** Default cap: params (B). Default 8 (blueprint §4.3). */
  readonly defaultMaxParamsB?: number;
  /** Default cap: quant bit-width. Default 4 (Q4 class). */
  readonly defaultMaxQuantBits?: number;
  /** Opt-in ceiling for large models (B). Default 14. */
  readonly largeMaxParamsB?: number;
  /** Large models allowed only while ≤ this many sessions resident. Def 6. */
  readonly largeMaxResidentSessions?: number;
}

export interface ResidentEntry {
  readonly key: string;
  readonly server: LocalModelServer;
  readonly estimatedResidentGb: number;
  /** Epoch ms of the last request touch. */
  readonly lastUsedAtMs: number;
  /** Epoch ms after which the resident is TTL-expired. */
  readonly expiresAtMs: number;
  /** In-flight request guard — never proposed for eviction while true. */
  readonly inUse: boolean;
}

export interface LoadEvaluationContext {
  readonly pressure: PressureState;
  /** Resident agent sessions (BE-9's count) — gates the 12–14B opt-in. */
  readonly residentSessionCount: number;
  /** Current residents across ALL servers (the global budget line). */
  readonly residents: readonly ResidentEntry[];
  /** Operator opted in to a 12–14B model for THIS request. */
  readonly largeOptIn?: boolean;
}

export type LoadDecision =
  | {
      readonly allow: true;
      readonly ttlSeconds: number;
      /** Idle residents to evict (verified-unload them) before loading. */
      readonly evict: readonly ResidentEntry[];
    }
  | {
      readonly allow: false;
      readonly reason:
        | 'exceeds-default-cap'
        | 'exceeds-large-cap'
        | 'large-needs-fewer-sessions'
        | 'budget-exhausted';
      readonly message: string;
    };

export interface ResidencyPolicy {
  evaluateLoad(model: LocalModelSpec, context: LoadEvaluationContext): LoadDecision;
  /** evaluateLoad, but throws the typed error on deny (control-verb path). */
  requireLoad(model: LocalModelSpec, context: LoadEvaluationContext): Extract<LoadDecision, { allow: true }>;
  readonly budgetGb: number;
}

export function createResidencyPolicy(options: ResidencyPolicyOptions = {}): ResidencyPolicy {
  const budgetGb = options.budgetGb ?? 12;
  const defaultMaxParamsB = options.defaultMaxParamsB ?? 8;
  const defaultMaxQuantBits = options.defaultMaxQuantBits ?? 4;
  const largeMaxParamsB = options.largeMaxParamsB ?? 14;
  const largeMaxResidentSessions = options.largeMaxResidentSessions ?? 6;

  const evaluateLoad = (
    model: LocalModelSpec,
    context: LoadEvaluationContext,
  ): LoadDecision => {
    const isLarge = model.paramsB > defaultMaxParamsB || model.quantBits > defaultMaxQuantBits;
    if (isLarge) {
      if (context.largeOptIn !== true) {
        return {
          allow: false,
          reason: 'exceeds-default-cap',
          message:
            `model exceeds the default cap (≤${String(defaultMaxParamsB)}B at ` +
            `≤${String(defaultMaxQuantBits)}-bit) and no large opt-in was given`,
        };
      }
      if (model.paramsB > largeMaxParamsB) {
        return {
          allow: false,
          reason: 'exceeds-large-cap',
          message: `model exceeds the ${String(largeMaxParamsB)}B opt-in ceiling`,
        };
      }
      if (context.residentSessionCount > largeMaxResidentSessions) {
        return {
          allow: false,
          reason: 'large-needs-fewer-sessions',
          message:
            `large models require ≤${String(largeMaxResidentSessions)} resident sessions ` +
            `(currently ${String(context.residentSessionCount)})`,
        };
      }
    }

    // Global budget line across LM Studio + Ollama residents. The same model
    // key re-loading is not double-counted.
    const others = context.residents.filter(
      (entry) => !(entry.key === model.key && entry.server === model.server),
    );
    const residentGb = others.reduce((sum, entry) => sum + entry.estimatedResidentGb, 0);
    let needed = residentGb + model.estimatedResidentGb - budgetGb;
    const evict: ResidentEntry[] = [];
    if (needed > 0) {
      // Oldest-idle first; in-use residents are never victims.
      const idle = others
        .filter((entry) => !entry.inUse)
        .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
      for (const entry of idle) {
        if (needed <= 0) break;
        evict.push(entry);
        needed -= entry.estimatedResidentGb;
      }
      if (needed > 0) {
        return {
          allow: false,
          reason: 'budget-exhausted',
          message:
            `loading would exceed the global local-model resident budget ` +
            `(${String(budgetGb)} GB) even after evicting all idle residents`,
        };
      }
    }
    return { allow: true, ttlSeconds: ttlForPressure(context.pressure), evict };
  };

  return {
    budgetGb,
    evaluateLoad,
    requireLoad: (model, context) => {
      const decision = evaluateLoad(model, context);
      if (!decision.allow) throw new ResidencyDeniedError(decision.reason, decision.message);
      return decision;
    },
  };
}

// ---------------------------------------------------------------------------
// Resident ledger (the global budget line's source of truth)
// ---------------------------------------------------------------------------

export interface ResidencyLedger {
  /** Record a (re)load. Same (server,key) replaces the previous entry. */
  register(entry: {
    readonly key: string;
    readonly server: LocalModelServer;
    readonly estimatedResidentGb: number;
    readonly ttlSeconds: number;
    readonly nowMs: number;
  }): void;
  /** A request touched the model — reset its TTL (JIT semantics). */
  touch(server: LocalModelServer, key: string, nowMs: number, ttlSeconds: number): void;
  /** Mark a request in-flight/settled so eviction never hits an active model. */
  setInUse(server: LocalModelServer, key: string, inUse: boolean): void;
  /** Drop an entry — call ONLY after the unload was VERIFIED via the API. */
  markUnloaded(server: LocalModelServer, key: string): void;
  residents(): readonly ResidentEntry[];
  /** TTL-expired residents at `nowMs` (candidates for verified unload). */
  sweep(nowMs: number): readonly ResidentEntry[];
  totalResidentGb(): number;
}

export function createResidencyLedger(): ResidencyLedger {
  interface MutableEntry {
    key: string;
    server: LocalModelServer;
    estimatedResidentGb: number;
    lastUsedAtMs: number;
    expiresAtMs: number;
    inUse: boolean;
  }
  const entries = new Map<string, MutableEntry>();
  const idOf = (server: LocalModelServer, key: string): string => `${server} ${key}`;
  const snapshot = (entry: MutableEntry): ResidentEntry => ({ ...entry });

  return {
    register: ({ key, server, estimatedResidentGb, ttlSeconds, nowMs }) => {
      entries.set(idOf(server, key), {
        key,
        server,
        estimatedResidentGb,
        lastUsedAtMs: nowMs,
        expiresAtMs: nowMs + ttlSeconds * 1000,
        inUse: false,
      });
    },
    touch: (server, key, nowMs, ttlSeconds) => {
      const entry = entries.get(idOf(server, key));
      if (entry === undefined) return;
      entry.lastUsedAtMs = nowMs;
      entry.expiresAtMs = nowMs + ttlSeconds * 1000;
    },
    setInUse: (server, key, inUse) => {
      const entry = entries.get(idOf(server, key));
      if (entry !== undefined) entry.inUse = inUse;
    },
    markUnloaded: (server, key) => {
      entries.delete(idOf(server, key));
    },
    residents: () => [...entries.values()].map(snapshot),
    sweep: (nowMs) =>
      [...entries.values()].filter((e) => !e.inUse && e.expiresAtMs <= nowMs).map(snapshot),
    totalResidentGb: () =>
      [...entries.values()].reduce((sum, entry) => sum + entry.estimatedResidentGb, 0),
  };
}
