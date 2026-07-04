/**
 * THE single approval inbox (plan FE-2; blueprint §4.1 two-layer permission
 * relay). Every escalation source lands here — `can-use-tool` (SDK in-loop),
 * `hook-floor` (account-wide policy floor, external sessions included),
 * `workflow-gate` (M5 pipelines) — and decisions ride the approvals channel
 * back (ws-protocol.md §10). Rows keep arrival order (fixed positions).
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ApprovalRequest, ApprovalVerdict } from '@aibender/protocol';
import { approvalsStore, pendingApprovals } from '../lib/stores/approvalsStore.ts';
import { useGatewayClient } from './clientContext.tsx';

/** Engraved source tags — terse instrument labeling, not marketing copy. */
const SOURCE_TAG: Record<ApprovalRequest['source'], string> = {
  'can-use-tool': 'TOOL',
  'hook-floor': 'FLOOR',
  'workflow-gate': 'GATE',
};

function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function metaLine(request: ApprovalRequest): string {
  const parts: string[] = [request.accountLabel];
  if (request.sessionId !== undefined) parts.push(`ses ${request.sessionId}`);
  if (request.toolName !== undefined) parts.push(`tool ${request.toolName}`);
  if (request.runId !== undefined) parts.push(`run ${request.runId}`);
  if (request.stepId !== undefined) parts.push(`step ${request.stepId}`);
  if (request.expiresAt !== undefined) parts.push(`expires ${fmtClock(request.expiresAt)}`);
  return parts.join(' · ');
}

export interface ApprovalInboxProps {
  /** Test seam; defaults to sending the decision through the client. */
  readonly onDecide?: (approvalId: string, verdict: ApprovalVerdict) => void;
}

export function ApprovalInbox({ onDecide }: ApprovalInboxProps): ReactNode {
  const pending = useStore(approvalsStore, (s) => s);
  const client = useGatewayClient();
  const rows = pendingApprovals(pending);

  const decide = (approvalId: string, verdict: ApprovalVerdict): void => {
    if (onDecide !== undefined) {
      onDecide(approvalId, verdict);
      return;
    }
    // Wire shape mirrors the golden corpus key order (§10.2). `updatedInput`
    // is only ever sent with allow AND only when input was edited — the M2
    // inbox approves the original input, so it is never included here.
    client?.sendApprovalDecision({ kind: 'approval-decision', approvalId, verdict });
  };

  return (
    <section id="ig-approvals" className="ig-inbox" aria-label="approval inbox" data-testid="approval-inbox">
      <header className="ig-panel-header" style={{ padding: '0 var(--ig-space-12)' }}>
        <span className="ig-engraved">APPROVALS</span>
        <span className="ig-panel-readout ig-engraved" data-testid="approvals-count">
          {rows.length > 0 ? <span className="ig-attention">{rows.length} PENDING</span> : 'CLEAR'}
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="ig-inbox-empty ig-engraved" style={{ color: 'var(--ig-ink-faint)' }}>
          NO PENDING APPROVALS
        </div>
      ) : (
        rows.map(({ request }) => (
          <div className="ig-inbox-row" key={request.approvalId} data-testid={`approval-${request.approvalId}`}>
            <span className="ig-inbox-source ig-engraved" data-testid={`source-${request.approvalId}`}>
              {SOURCE_TAG[request.source]}
            </span>
            <span className="ig-inbox-summary" title={request.summary}>
              {request.summary}
            </span>
            <span className="ig-inbox-meta">{metaLine(request)}</span>
            <button
              type="button"
              className="ig-btn ig-btn-primary"
              onClick={() => decide(request.approvalId, 'allow')}
              data-testid={`allow-${request.approvalId}`}
            >
              ALLOW
            </button>
            <button
              type="button"
              className="ig-btn"
              onClick={() => decide(request.approvalId, 'deny')}
              data-testid={`deny-${request.approvalId}`}
            >
              DENY
            </button>
          </div>
        ))
      )}
    </section>
  );
}
