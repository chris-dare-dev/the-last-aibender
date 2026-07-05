/**
 * The memoization-journal key: `sha256` of a step attempt's RESOLVED inputs
 * (BE-8; findings pipeline-workflow-builder §R3 / sqlite-ddl.md §10
 * `step_attempt.input_hash`). Two attempts with the same resolved inputs on
 * the same (runId, stepId, iteration) are the SAME work — a completed one's
 * output is returned on resume WITHOUT re-execution (the M5 DoD).
 *
 * The hash MUST be over the RESOLVED invocation (post-templating), NOT the raw
 * step, so a step whose upstream output changed re-executes (its input_hash
 * differs) while an unchanged step is a cache hit. Keys are ordered
 * deterministically so serialization order never perturbs the hash.
 */

import { createHash } from 'node:crypto';

/** The resolved-input surface that defines a step attempt's cache identity. */
export interface StepInputIdentity {
  readonly kind: string;
  readonly account: string;
  readonly backend: string;
  readonly cwd: string;
  /** Rendered prompt (prompt/agent/skill), when applicable. */
  readonly prompt?: string;
  readonly skillName?: string;
  readonly agentName?: string;
  readonly scriptPath?: string;
  /**
   * The pinned capability contentHash (skill/agent steps): a drifted source
   * changes the hash, so a drifted step is NOT a cache hit even at the same
   * (id, iteration) — belt-and-suspenders with the planner's drift detection.
   */
  readonly capabilityContentHash?: string;
  /** The forEach element for this iteration, when applicable. */
  readonly item?: unknown;
}

/** Compute the deterministic `sha256:<hex>` input hash for a step attempt. */
export function computeInputHash(identity: StepInputIdentity): string {
  const canonical = canonicalize(identity);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Deterministic JSON with sorted keys (order never perturbs the hash). */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}
