/**
 * Spec-only builders for the pipelines suites (imported by *.spec files
 * exclusively — never by shipped modules). All values are synthesized; the
 * identity-shaped strings are runtime-built so no scanner-shaped literal is
 * committed to this public repo (testkit convention) [X2].
 */

import type {
  CatalogEntry,
  CatalogSnapshot,
  PipelineRunSnapshot,
  PipelineRunState,
  PipelineRunStatusEvent,
  PipelineRunStatusRecord,
  PipelineStepState,
  PipelineStepStatusEvent,
  PipelineStepStatusRecord,
} from '@aibender/protocol';

export const T0 = 90_100_000;

export function catalogEntry(
  capId: string,
  overrides: Partial<Omit<CatalogEntry, 'capId'>> = {},
): CatalogEntry {
  return {
    capId,
    kind: 'skill',
    name: `cap ${capId}`,
    scope: 'project',
    backendFamily: 'claude',
    sourcePath: `/synthetic/workspace/.claude/skills/${capId}/SKILL.md`,
    contentHash: 'sha256:deadbeefcafe',
    ...overrides,
  };
}

export function catalogSnapshot(
  entries: readonly CatalogEntry[],
  overrides: Partial<Omit<CatalogSnapshot, 'kind' | 'entries'>> = {},
): CatalogSnapshot {
  return { kind: 'catalog-snapshot', capturedAt: T0, entries, ...overrides };
}

export function runStatus(
  runId: string,
  state: PipelineRunState,
  overrides: Partial<Omit<PipelineRunStatusRecord, 'runId' | 'state'>> = {},
): PipelineRunStatusRecord {
  return { runId, pipelineId: 'wf_fake_1', state, ...overrides };
}

export function runStatusEvent(
  runId: string,
  state: PipelineRunState,
  overrides: Partial<Omit<PipelineRunStatusRecord, 'runId' | 'state'>> = {},
): PipelineRunStatusEvent {
  return { kind: 'pipeline-run-status', ...runStatus(runId, state, overrides) };
}

export function stepStatus(
  runId: string,
  stepId: string,
  state: PipelineStepState,
  overrides: Partial<Omit<PipelineStepStatusRecord, 'runId' | 'stepId' | 'state'>> = {},
): PipelineStepStatusRecord {
  return { runId, stepId, iteration: 0, attempt: 0, state, ...overrides };
}

export function stepStatusEvent(
  runId: string,
  stepId: string,
  state: PipelineStepState,
  overrides: Partial<Omit<PipelineStepStatusRecord, 'runId' | 'stepId' | 'state'>> = {},
): PipelineStepStatusEvent {
  return { kind: 'pipeline-step-status', ...stepStatus(runId, stepId, state, overrides) };
}

export function runSnapshot(
  run: PipelineRunStatusRecord,
  steps: readonly PipelineStepStatusRecord[],
  capturedAt = T0,
): PipelineRunSnapshot {
  return { kind: 'pipeline-run-snapshot', capturedAt, run, steps };
}

/** Identity-shaped adversarial strings (runtime-built — never literals). */
export function adversarialStrings(): { emailish: string; awsIdish: string; tokenish: string } {
  return {
    emailish: ['owner.real', 'example.com'].join('@'),
    awsIdish: '987654'.repeat(2),
    tokenish: ['sk', 'live0token0live0'].join('-'),
  };
}
