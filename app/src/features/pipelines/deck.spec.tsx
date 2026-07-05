// @vitest-environment jsdom
/**
 * Deck behaviour walk (plan §9.2 FE-6): the run-monitor state walk over EVERY
 * frozen step state; per-step cost render; the approval-gate deep-link into
 * THE single inbox (M2 — deep-links to #ig-approvals, builds no second inbox);
 * the resume-from-journal affordance (enabled iff resumable); the builder
 * validate/save/launch flow with the frozen dag/ issue class as an instrument
 * state; and the unsendable state when no sender seam is present (ICR pending).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PIPELINE_STEP_STATES,
  type PipelineClientPayload,
  type PipelineStepState,
} from '@aibender/protocol';
import { approvalsStore, connectionStore } from '../../lib/index.ts';
import { STEP_STATE_READOUT } from './runMonitor.ts';
import { pipelinesStore, type PipelineVerbSender } from './index.ts';
import { PipelinesDeck } from './PipelinesDeck.tsx';
import {
  catalogEntry,
  catalogSnapshot,
  runSnapshot,
  runStatus,
  stepStatus,
} from './specHelpers.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function recordingSender(): { sender: PipelineVerbSender; sent: PipelineClientPayload[] } {
  const sent: PipelineClientPayload[] = [];
  return {
    sent,
    sender: {
      sendPipelineMessage(message) {
        sent.push(message);
        return true;
      },
    },
  };
}

describe('pipelines deck', () => {
  let root: Root;
  let host: HTMLElement;
  let scrolled: string[];

  beforeEach(() => {
    pipelinesStore.getState().reset();
    approvalsStore.getState().reset();
    connectionStore.getState().reset();
    connectionStore.getState().setPhase('connected');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // Stub the approval-inbox anchor so the gate deep-link can be observed.
    scrolled = [];
    const inbox = document.createElement('div');
    inbox.id = 'ig-approvals';
    inbox.scrollIntoView = () => scrolled.push('ig-approvals');
    document.body.appendChild(inbox);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.getElementById('ig-approvals')?.remove();
    connectionStore.getState().reset();
  });

  function renderDeck(props: Record<string, unknown> = {}): void {
    act(() => root.render(<PipelinesDeck {...props} />));
  }
  function click(testId: string): void {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing ${testId}`);
    act(() => el.click());
  }

  it('walks EVERY frozen step state with its readout', () => {
    const steps = PIPELINE_STEP_STATES.map((state, i) =>
      stepStatus('run_1', `s${i}`, state as PipelineStepState, { account: 'MAX_A' }),
    );
    pipelinesStore.getState().applyBatch([runSnapshot(runStatus('run_1', 'running'), steps)]);
    renderDeck();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    for (let i = 0; i < PIPELINE_STEP_STATES.length; i += 1) {
      const state = PIPELINE_STEP_STATES[i] as PipelineStepState;
      const row = host.querySelector(`[data-testid="pl-run-state-s${i}"]`);
      expect(row?.textContent, state).toBe(STEP_STATE_READOUT[state]);
    }
  });

  it('renders per-step cost EST from the events-store-fed payload', () => {
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'running'), [
        stepStatus('run_1', 'a', 'completed', { account: 'MAX_A', costEstimatedUsd: 0.1234 }),
      ]),
    ]);
    renderDeck();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    expect(host.querySelector('[data-testid="pl-run-cost-a"]')?.textContent).toBe('$0.1234 EST');
  });

  it('surfaces an identifier-free failure class on a failed step', () => {
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'failed'), [
        stepStatus('run_1', 'a', 'failed', { account: 'AWS_DEV', errorKind: 'budget-exceeded' }),
      ]),
    ]);
    renderDeck();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    expect(host.querySelector('[data-testid="pl-run-error-a"]')?.textContent).toBe('budget-exceeded');
    expect(host.querySelector('[data-testid="pl-run-step-a-0-0"]')?.getAttribute('data-status')).toBe(
      'fault',
    );
  });

  it('an awaiting-approval gate deep-links to THE single inbox (M2 — no 2nd inbox)', () => {
    // The pending workflow-gate approval is in the SHARED approvals store.
    approvalsStore.getState().applyServer(
      {
        kind: 'approval-request',
        approvalId: 'apr_gate',
        source: 'workflow-gate',
        summary: 'review',
        accountLabel: 'MAX_A',
        runId: 'run_1',
        stepId: 'gate',
      },
      0,
    );
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'paused'), [
        stepStatus('run_1', 'gate', 'awaiting-approval'),
      ]),
    ]);
    renderDeck();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    const gateBtn = host.querySelector('[data-testid="pl-run-gate-gate"]');
    expect(gateBtn?.textContent).toBe('DECIDE IN INBOX');
    expect(gateBtn?.getAttribute('data-approval')).toBe('apr_gate');
    click('pl-run-gate-gate');
    // Deep-link scrolls THE single inbox anchor — it does not render a decision UI.
    expect(scrolled).toContain('ig-approvals');
    expect(host.querySelector('[data-testid="pl-approval-decision"]')).toBeNull();
  });

  it('an awaiting gate with no matched inbox entry reads AWAITING GATE', () => {
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'paused'), [
        stepStatus('run_1', 'gate', 'awaiting-approval'),
      ]),
    ]);
    renderDeck();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    expect(host.querySelector('[data-testid="pl-run-gate-gate"]')?.textContent).toBe('AWAITING GATE');
  });

  it('the resume affordance enables iff the run is resumable, and round-trips', () => {
    const { sender, sent } = recordingSender();
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'paused', { resumable: true }), [
        stepStatus('run_1', 'a', 'memoized', { account: 'MAX_A' }),
      ]),
    ]);
    renderDeck({ sender });
    click('pl-mode-monitor');
    click('pl-run-run_1');
    const resume = host.querySelector<HTMLButtonElement>('[data-testid="pl-run-resume"]');
    expect(resume?.disabled).toBe(false);
    expect(resume?.getAttribute('data-resumable')).toBe('true');
    click('pl-run-resume');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('pipeline-resume');
    expect(pipelinesStore.getState().verbs[sent[0]?.requestId ?? '']?.phase).toBe('pending');
  });

  it('a non-resumable run disables the resume control', () => {
    pipelinesStore.getState().applyBatch([
      runSnapshot(runStatus('run_1', 'running'), [stepStatus('run_1', 'a', 'running')]),
    ]);
    renderDeck();
    click('pl-mode-monitor');
    click('pl-run-run_1');
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="pl-run-resume"]')?.disabled,
    ).toBe(true);
    // …but pause is enabled while running.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="pl-run-pause"]')?.disabled).toBe(
      false,
    );
  });

  it('the builder blocks an empty canvas client-side (bad-shape instrument state)', () => {
    renderDeck();
    click('pl-validate');
    expect(host.querySelector('[data-testid="pl-verb-readout"]')?.textContent).toContain('INVALID');
    expect(host.querySelector('[data-testid="pl-verb-issue"]')?.textContent).toContain('bad-shape');
    expect(host.querySelector('[data-testid="pl-verbs"]')?.getAttribute('data-status')).toBe('fault');
  });

  it('the builder composes a step from the palette + routes it + launches it', () => {
    const { sender, sent } = recordingSender();
    pipelinesStore.getState().applyBatch([
      catalogSnapshot([catalogEntry('cap_1', { kind: 'skill', name: 'write-report' })]),
    ]);
    renderDeck({ sender });
    // Drop the skill onto the canvas.
    click('pl-cap-add-cap_1');
    // The step wears an account chip (the [X1] differentiator, visually first-class).
    const account = host.querySelector('[data-testid^="pl-step-account-"]');
    expect(account).not.toBeNull();
    // Launch: a valid single-skill DAG dispatches the frozen launch verb.
    click('pl-launch');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('pipeline-launch');
    // Launch flips the deck to the monitor.
    expect(
      host.querySelector('[data-testid="pl-mode-monitor"]')?.getAttribute('data-selected'),
    ).toBe('true');
  });

  it('with no sender seam (ICR pending) a dispatch renders unsendable (no throw)', () => {
    pipelinesStore.getState().applyBatch([
      catalogSnapshot([catalogEntry('cap_1', { kind: 'skill', name: 'write-report' })]),
    ]);
    renderDeck(); // no sender
    click('pl-cap-add-cap_1');
    click('pl-save');
    expect(host.querySelector('[data-testid="pl-verb-readout"]')?.textContent).toBe('NOT CONNECTED');
    expect(host.querySelector('[data-testid="pl-verbs"]')?.getAttribute('data-status')).toBe(
      'nosignal',
    );
  });

  it('a down gateway dims the whole deck to NO SIGNAL, slots retained', () => {
    connectionStore.getState().setPhase('no-broker');
    renderDeck();
    const readouts = [...host.querySelectorAll('[data-testid="pl-nosignal"]')];
    expect(readouts).toHaveLength(3);
    expect(host.querySelector('[data-testid="pl-palette"]')).toBeNull();
  });
});
