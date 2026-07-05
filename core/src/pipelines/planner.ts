/**
 * Plan-time capability resolution + drift detection (BE-8; findings
 * pipeline-workflow-builder §R2 "Skill/agent references … are resolved against
 * the catalog FOR THE STEP'S cwd at plan time; the resolved sourcePath +
 * contentHash are pinned into the run record so a rerun months later can
 * detect drift").
 *
 * The planner runs ONCE per run, before the walk:
 *   1. resolve every `skill`/`agent` step's `{name, scope?}` against the
 *      catalog for the run's (workspace, accounts) — an unresolved reference
 *      is a TYPED REFUSAL (`unresolved-capability`), the run never starts
 *      (plan §9.2 negative: "unresolved capability ref fails plan");
 *   2. PIN each resolved capability's `sourcePath` + `contentHash` into the
 *      plan;
 *   3. on a RESUME, compare the pinned hash against the catalog's CURRENT hash
 *      — a mismatch is `capability-drift` (plan §9.2 edge: "contentHash drift
 *      between plan and run detected and surfaced"). The journal is invalid for
 *      that step; its memoized output is discarded.
 *
 * The DAG document itself is validated by the frozen `validateDagDocument`
 * (the runner runs it first) — cycles/dangling-needs/bad-shape are caught
 * there. The planner adds ONLY the catalog-resolution layer the validator
 * cannot do (it has no catalog).
 */

import type { AccountLabel, DagDocument, PipelineStep } from '@aibender/protocol';

import type { CatalogRecord } from './catalog/index.js';

/** A capability the catalog can resolve for a step. */
export interface ResolvedCapability {
  readonly capId: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly contentHash: string;
}

/** The plan's per-step pinned capability (skill/agent steps only). */
export interface PinnedStep {
  readonly stepId: string;
  readonly capability: ResolvedCapability;
}

export type PlanIssueCode = 'unresolved-capability' | 'capability-drift';

export interface PlanIssue {
  readonly code: PlanIssueCode;
  /** Identifier-free [X2]. */
  readonly message: string;
  readonly stepId: string;
}

export interface PlanOk {
  readonly ok: true;
  /** Resolved capabilities keyed by step id (skill/agent steps). */
  readonly pins: Readonly<Record<string, ResolvedCapability>>;
}

export interface PlanFailed {
  readonly ok: false;
  readonly issue: PlanIssue;
}

export type PlanResult = PlanOk | PlanFailed;

/**
 * A catalog lookup for the planner — a function of (name, scope, backendFamily)
 * → the resolved record, or undefined when unresolved. The composition root
 * builds this from a {@link CatalogScanResult}; tests pass a Map-backed fake.
 * The scope is a HINT: an exact scope match wins, else the first record with
 * the name (the scanner already resolved precedence).
 */
export type CatalogResolver = (query: {
  readonly name: string;
  readonly scope?: string;
  readonly kinds: readonly string[];
}) => CatalogRecord | undefined;

/**
 * Resolve + pin every skill/agent step's capability. Prompt/workflow-script/
 * approval steps need no resolution. Never throws.
 */
export function planCapabilities(
  document: DagDocument,
  resolver: CatalogResolver,
): PlanResult {
  const pins: Record<string, ResolvedCapability> = {};
  for (const step of document.steps) {
    const ref = capabilityRefOf(step);
    if (ref === undefined) continue;
    const record = resolver({
      name: ref.name,
      ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
      kinds: ref.kinds,
    });
    if (record === undefined) {
      return {
        ok: false,
        issue: {
          code: 'unresolved-capability',
          message: `step ${step.id} references ${ref.kindLabel} ${JSON.stringify(ref.name)} which the catalog does not resolve for this workspace/account`,
          stepId: step.id,
        },
      };
    }
    pins[step.id] = {
      capId: record.capId,
      name: record.name,
      sourcePath: record.sourcePath,
      contentHash: record.contentHash,
    };
  }
  return { ok: true, pins };
}

/**
 * Detect drift on RESUME: for each pinned step, if the catalog's CURRENT hash
 * for the capability differs from the pinned hash, that step's journal is
 * stale. Returns the drifted step ids (empty = no drift). The runner discards
 * the memoized output for a drifted step (journal invalidation on contentHash
 * drift — the M5 DoD).
 */
export function detectDrift(
  pins: Readonly<Record<string, ResolvedCapability>>,
  resolver: CatalogResolver,
  document: DagDocument,
): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byId = new Map(document.steps.map((s) => [s.id, s]));
  for (const [stepId, pinned] of Object.entries(pins)) {
    const step = byId.get(stepId);
    if (step === undefined) continue;
    const ref = capabilityRefOf(step);
    if (ref === undefined) continue;
    const current = resolver({
      name: ref.name,
      ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
      kinds: ref.kinds,
    });
    // Unresolved-on-resume OR changed hash → drift for this step.
    if (current === undefined || current.contentHash !== pinned.contentHash) {
      issues.push({
        code: 'capability-drift',
        message: `step ${stepId}: pinned ${ref.kindLabel} source changed since the run was planned (memoized output discarded)`,
        stepId,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StepCapabilityRef {
  readonly name: string;
  readonly scope?: string;
  readonly kinds: readonly string[];
  readonly kindLabel: 'skill' | 'agent';
}

function capabilityRefOf(step: PipelineStep): StepCapabilityRef | undefined {
  if (step.kind === 'skill') {
    return {
      name: step.skill.name,
      ...(step.skill.scope !== undefined ? { scope: step.skill.scope } : {}),
      // A `skill` step resolves against skills OR commands (§1.2 merged).
      kinds: ['skill', 'command', 'oc-command'],
      kindLabel: 'skill',
    };
  }
  if (step.kind === 'agent') {
    return {
      name: step.agent.name,
      ...(step.agent.scope !== undefined ? { scope: step.agent.scope } : {}),
      kinds: ['agent', 'oc-agent'],
      kindLabel: 'agent',
    };
  }
  return undefined;
}

/**
 * Build a {@link CatalogResolver} over a set of scanned records. Exact-scope
 * match wins; else the first record whose kind is in the query set (the
 * scanner already applied precedence, so "first" is "highest-precedence").
 * Account filtering is applied when a step's account is known — but the base
 * resolver here matches on name+kind; the runner passes account via the
 * account-aware wrapper below.
 */
export function resolverFromRecords(records: readonly CatalogRecord[]): CatalogResolver {
  return ({ name, scope, kinds }) => {
    const kindSet = new Set(kinds);
    const candidates = records.filter((r) => r.name === name && kindSet.has(r.kind));
    if (candidates.length === 0) return undefined;
    if (scope !== undefined) {
      const exact = candidates.find((r) => r.scope === scope);
      if (exact !== undefined) return exact;
    }
    return candidates[0];
  };
}

/**
 * Wrap a resolver so it additionally requires a record to resolve for a given
 * account (findings §R3: "a skill in MAX_A's config dir doesn't exist for ENT
 * runs"). A project/opencode-scope entry (no `accounts` list) resolves for any
 * account; a user/plugin entry must list the account.
 */
export function accountScopedResolver(
  base: CatalogResolver,
  account: AccountLabel,
): CatalogResolver {
  return (query) => {
    const record = base(query);
    if (record === undefined) return undefined;
    if (record.accounts !== undefined && !record.accounts.includes(account)) return undefined;
    return record;
  };
}
