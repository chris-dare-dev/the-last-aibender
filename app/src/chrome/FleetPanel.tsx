/**
 * Left zone — the fleet: session list (workstream tree and pipeline runs
 * join at M4/M5 via FE-6, same zone). Rows are a mono data grid on the
 * character rhythm; status tints are the only tinted backgrounds.
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { SessionState } from '@aibender/protocol';
import { sessionsStore } from '../lib/stores/sessionsStore.ts';
import { uiStore } from './uiStore.ts';

type RowStatus = 'ok' | 'degraded' | 'fault' | 'nosignal';

/** Ledger state → semantic status (DESIGN.md §2.4 meanings, exhaustive). */
export function sessionRowStatus(state: SessionState): RowStatus {
  switch (state) {
    case 'running':
    case 'resumed':
      return 'ok';
    case 'spawning':
    case 'orphan_detected':
      return 'degraded';
    case 'orphan_killed':
      return 'fault';
    case 'exited':
      return 'nosignal';
    default:
      return 'nosignal';
  }
}

export function FleetPanel(): ReactNode {
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const order = useStore(sessionsStore, (s) => s.order);
  const selected = useStore(uiStore, (s) => s.selectedSessionId);
  const selectSession = useStore(uiStore, (s) => s.selectSession);

  return (
    <section aria-label="fleet" data-testid="fleet-panel">
      <div className="ig-panel">
        <header className="ig-panel-header">
          <span className="ig-engraved">FLEET</span>
          <span className="ig-panel-readout ig-engraved">{order.length} SES</span>
        </header>
      </div>
      <div className="ig-panel-body">
        {order.length === 0 ? (
          <div className="ig-inbox-empty ig-engraved" style={{ color: 'var(--ig-ink-faint)' }}>
            NO SESSIONS
          </div>
        ) : (
          order.map((sessionId) => {
            const session = sessions[sessionId];
            if (session === undefined) return null;
            const status = sessionRowStatus(session.state);
            return (
              <div
                key={sessionId}
                className="ig-fleet-row"
                data-status={status}
                data-selected={selected === sessionId}
                data-testid={`fleet-${sessionId}`}
                role="button"
                tabIndex={0}
                onClick={() => selectSession(sessionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') selectSession(sessionId);
                }}
              >
                <span className={`ig-engraved ig-status-${status}`}>{session.state.toUpperCase()}</span>
                <span className="ig-fleet-id">{sessionId}</span>
                <span className="ig-engraved">{session.accountLabel}</span>
                <span className="ig-engraved">{session.substrate.toUpperCase()}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
