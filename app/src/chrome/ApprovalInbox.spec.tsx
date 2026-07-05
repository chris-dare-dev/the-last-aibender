// @vitest-environment jsdom
/**
 * THE single approval inbox (plan §9.2 FE-2 positive row: "inbox renders
 * all three approval sources"). Round-trip: request → rendered row →
 * decision wire message → resolved fan-out clears the row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalsServerPayload, ApprovalVerdict } from '@aibender/protocol';
import { approvalsStore } from '../lib/stores/approvalsStore.ts';
import { ApprovalInbox } from './ApprovalInbox.tsx';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The three golden-corpus request shapes — one per source (§10.1 matrix). */
const REQUESTS: ApprovalsServerPayload[] = [
  {
    kind: 'approval-request',
    approvalId: 'apr_fake_1',
    source: 'can-use-tool',
    summary: 'synthesized tool escalation',
    accountLabel: 'MAX_A',
    sessionId: 'ses_fake_1',
    toolName: 'Bash',
    toolUseId: 'synthtool-2',
    expiresAt: 90061000,
  },
  {
    kind: 'approval-request',
    approvalId: 'apr_fake_2',
    source: 'hook-floor',
    summary: 'synthesized policy-floor escalation',
    accountLabel: 'ENT',
    sessionId: 'ses_fake_2',
    toolName: 'Write',
  },
  {
    kind: 'approval-request',
    approvalId: 'apr_fake_3',
    source: 'workflow-gate',
    summary: 'synthesized pipeline gate',
    accountLabel: 'AWS_DEV',
    runId: 'run_fake_1',
    stepId: 'step_fake_2',
  },
];

describe('ApprovalInbox', () => {
  let root: Root;
  let host: HTMLElement;
  const decisions: { approvalId: string; verdict: ApprovalVerdict }[] = [];

  beforeEach(() => {
    approvalsStore.getState().reset();
    decisions.length = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <ApprovalInbox onDecide={(approvalId, verdict) => decisions.push({ approvalId, verdict })} />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders all three sources with their engraved tags, in arrival order', () => {
    act(() => {
      for (const request of REQUESTS) approvalsStore.getState().applyServer(request, 90000000);
    });
    expect(host.querySelector('[data-testid="source-apr_fake_1"]')?.textContent).toBe('TOOL');
    expect(host.querySelector('[data-testid="source-apr_fake_2"]')?.textContent).toBe('FLOOR');
    expect(host.querySelector('[data-testid="source-apr_fake_3"]')?.textContent).toBe('GATE');
    const rows = [...host.querySelectorAll('[data-testid^="approval-apr_"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['approval-apr_fake_1', 'approval-apr_fake_2', 'approval-apr_fake_3']);
    expect(host.querySelector('[data-testid="approvals-count"]')?.textContent).toContain('3 PENDING');
  });

  it('decision round-trip: allow + deny reach the decision sink', () => {
    act(() => {
      for (const request of REQUESTS) approvalsStore.getState().applyServer(request, 90000000);
    });
    act(() => {
      (host.querySelector('[data-testid="allow-apr_fake_1"]') as HTMLButtonElement).click();
    });
    act(() => {
      (host.querySelector('[data-testid="deny-apr_fake_3"]') as HTMLButtonElement).click();
    });
    expect(decisions).toEqual([
      { approvalId: 'apr_fake_1', verdict: 'allow' },
      { approvalId: 'apr_fake_3', verdict: 'deny' },
    ]);
  });

  it('approval-resolved fan-out clears the row (even for the decider)', () => {
    act(() => {
      for (const request of REQUESTS) approvalsStore.getState().applyServer(request, 90000000);
      approvalsStore
        .getState()
        .applyServer({ kind: 'approval-resolved', approvalId: 'apr_fake_2', outcome: 'expired' }, 90061001);
    });
    expect(host.querySelector('[data-testid="approval-apr_fake_2"]')).toBeNull();
    expect(host.querySelector('[data-testid="approvals-count"]')?.textContent).toContain('2 PENDING');
  });

  it('renders the engraved empty state, never an error (negative)', () => {
    expect(host.textContent).toContain('NO PENDING APPROVALS');
  });
});

/**
 * FE-2 — the decision race. The default (client-send) decide() path marks the
 * approval `deciding` before the fire-and-forget send, so its row hides
 * immediately: a second click cannot double-send and the row cannot stutter
 * against the broker-pushed `approval-resolved`.
 */
describe('ApprovalInbox — FE-2 decision race (deciding state)', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    approvalsStore.getState().reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // No onDecide seam, no client → the default path runs markDeciding then a
    // no-op send (client undefined). Exactly the store behavior under test.
    act(() => root.render(<ApprovalInbox />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('hides the row the instant a decision is sent (no stutter, single row)', () => {
    act(() => {
      approvalsStore.getState().applyServer(REQUESTS[0]!, 90000000);
    });
    expect(host.querySelector('[data-testid="approval-apr_fake_1"]')).not.toBeNull();

    act(() => {
      (host.querySelector('[data-testid="allow-apr_fake_1"]') as HTMLButtonElement).click();
    });
    // Row is gone AND the store still holds it pending (not yet resolved).
    expect(host.querySelector('[data-testid="approval-apr_fake_1"]')).toBeNull();
    expect(host.querySelector('[data-testid="approvals-count"]')?.textContent).toContain('CLEAR');
    const s = approvalsStore.getState();
    expect('apr_fake_1' in s.pending).toBe(true); // still pending on the broker
    expect('apr_fake_1' in s.deciding).toBe(true); // but decision is in flight
  });

  it('a second click cannot re-enter the deciding set (idempotent, no double-send)', () => {
    act(() => {
      approvalsStore.getState().applyServer(REQUESTS[0]!, 90000000);
    });
    const allow = host.querySelector('[data-testid="allow-apr_fake_1"]') as HTMLButtonElement;
    act(() => allow.click());
    // The row (and its button) are gone; markDeciding is idempotent regardless.
    expect(host.querySelector('[data-testid="allow-apr_fake_1"]')).toBeNull();
    // Re-invoking markDeciding directly is a no-op (already deciding).
    const before = { ...approvalsStore.getState().deciding };
    act(() => approvalsStore.getState().markDeciding('apr_fake_1'));
    expect(approvalsStore.getState().deciding).toEqual(before);
  });

  it('the broker-pushed approval-resolved clears the deciding state', () => {
    act(() => {
      approvalsStore.getState().applyServer(REQUESTS[0]!, 90000000);
    });
    act(() => {
      (host.querySelector('[data-testid="allow-apr_fake_1"]') as HTMLButtonElement).click();
    });
    expect('apr_fake_1' in approvalsStore.getState().deciding).toBe(true);
    // Broker resolves the now-in-flight decision.
    act(() => {
      approvalsStore
        .getState()
        .applyServer({ kind: 'approval-resolved', approvalId: 'apr_fake_1', outcome: 'allowed' }, 90000100);
    });
    const s = approvalsStore.getState();
    expect('apr_fake_1' in s.deciding).toBe(false); // cleared
    expect('apr_fake_1' in s.pending).toBe(false); // resolved out of pending
    expect(s.recentResolved.at(-1)?.approvalId).toBe('apr_fake_1');
  });

  it('markDeciding on an unknown/not-pending id is a no-op', () => {
    act(() => approvalsStore.getState().markDeciding('apr_never_seen'));
    expect(approvalsStore.getState().deciding).toEqual({});
  });
});
