/**
 * Run-monitor derivations (plan §9.2 FE-6): the status-register mapping is
 * TOTAL over the frozen run/step state enums; run controls gate pause/resume/
 * cancel correctly (resume ⇐ resumable, the M5 DoD affordance); cost rolls up
 * from the run record or the step rows; the approval-gate deep-link matches an
 * awaiting-approval step to the pending workflow-gate approval by (runId,
 * stepId) — THE single inbox (M2), no second inbox.
 */

import { describe, expect, it } from 'vitest';
import {
  PIPELINE_RUN_STATES,
  PIPELINE_STEP_STATES,
  type ApprovalRequest,
} from '@aibender/protocol';
import type { PendingApproval } from '../../lib/index.ts';
import {
  RUN_STATE_READOUT,
  STEP_STATE_READOUT,
  gateApprovalFor,
  isAwaitingApproval,
  runAccountsUsed,
  runControlsFor,
  runCostEstimate,
  runStatusRegister,
  stepStatusRegister,
} from './runMonitor.ts';
import { runStatus, stepStatus } from './specHelpers.ts';

describe('status registers are total over the frozen enums', () => {
  it('every run state maps to a register + a readout', () => {
    for (const state of PIPELINE_RUN_STATES) {
      expect(['ok', 'degraded', 'fault', 'nosignal']).toContain(runStatusRegister(state));
      expect(RUN_STATE_READOUT[state]).toBeTypeOf('string');
    }
  });
  it('every step state maps to a register + a readout', () => {
    for (const state of PIPELINE_STEP_STATES) {
      expect(['ok', 'degraded', 'fault', 'nosignal']).toContain(stepStatusRegister(state));
      expect(STEP_STATE_READOUT[state]).toBeTypeOf('string');
    }
  });
  it('memoized and completed both read as OK (settled, cached)', () => {
    expect(stepStatusRegister('memoized')).toBe('ok');
    expect(stepStatusRegister('completed')).toBe('ok');
    expect(STEP_STATE_READOUT.memoized).toBe('MEMOIZED');
  });
});

describe('run controls (pause / resume / cancel gating)', () => {
  it('running → pausable + cancellable, not resumable', () => {
    expect(runControlsFor(runStatus('r', 'running'))).toEqual({
      pausable: true,
      resumable: false,
      cancellable: true,
    });
  });
  it('paused + resumable → resume affordance shows (the M5 DoD)', () => {
    const c = runControlsFor(runStatus('r', 'paused', { resumable: true }));
    expect(c.resumable).toBe(true);
    expect(c.pausable).toBe(false);
    expect(c.cancellable).toBe(true);
  });
  it('a completed run offers no controls', () => {
    expect(runControlsFor(runStatus('r', 'completed', { resumable: true }))).toEqual({
      pausable: false,
      resumable: false,
      cancellable: false,
    });
  });
});

describe('cost rollup + routing summary', () => {
  it('uses the run record cost when present', () => {
    expect(runCostEstimate(runStatus('r', 'running', { costEstimatedUsd: 0.5 }), [])).toBe(0.5);
  });
  it('sums the step rows when the run has no rollup', () => {
    const steps = [
      stepStatus('r', 'a', 'completed', { costEstimatedUsd: 0.01 }),
      stepStatus('r', 'b', 'completed', { costEstimatedUsd: 0.02 }),
    ];
    expect(runCostEstimate(runStatus('r', 'completed'), steps)).toBeCloseTo(0.03);
  });
  it('lists distinct accounts the run routed across (the [X1] summary)', () => {
    const steps = [
      stepStatus('r', 'a', 'completed', { account: 'MAX_A' }),
      stepStatus('r', 'b', 'completed', { account: 'AWS_DEV' }),
      stepStatus('r', 'c', 'completed', { account: 'MAX_A' }),
      stepStatus('r', 'd', 'completed', { account: 'LOCAL' }),
    ];
    expect(runAccountsUsed(steps)).toEqual(['MAX_A', 'AWS_DEV', 'LOCAL']);
  });
});

describe('approval-gate deep-link (THE single inbox, M2 — no second inbox)', () => {
  function pending(req: Partial<ApprovalRequest>): PendingApproval {
    return {
      request: {
        kind: 'approval-request',
        approvalId: 'apr_1',
        source: 'workflow-gate',
        summary: 'gate',
        accountLabel: 'MAX_A',
        runId: 'run_1',
        stepId: 'gate',
        ...req,
      } as ApprovalRequest,
      receivedAtMs: 0,
    };
  }

  it('matches the pending workflow-gate approval by (runId, stepId)', () => {
    expect(gateApprovalFor('run_1', 'gate', [pending({})])).toBe('apr_1');
  });
  it('ignores a can-use-tool approval (wrong source)', () => {
    const other = pending({ source: 'can-use-tool', approvalId: 'apr_2' });
    expect(gateApprovalFor('run_1', 'gate', [other])).toBeUndefined();
  });
  it('does not match a different run/step', () => {
    expect(gateApprovalFor('run_2', 'gate', [pending({})])).toBeUndefined();
    expect(gateApprovalFor('run_1', 'other', [pending({})])).toBeUndefined();
  });
  it('isAwaitingApproval flags the gate step', () => {
    expect(isAwaitingApproval(stepStatus('r', 'g', 'awaiting-approval'))).toBe(true);
    expect(isAwaitingApproval(stepStatus('r', 'g', 'running'))).toBe(false);
  });
});
