/**
 * Top status rail: app identity, THE gateway readout (auth failure is
 * VISIBLY a fault here — plan §9.2 FE-2 negative row), approvals attention
 * count, protocol pin, settings verb. Status transitions snap (§3.6).
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { PROTOCOL_FREEZE } from '@aibender/protocol';
import { connectionStore } from '../lib/stores/connectionStore.ts';
import { approvalsStore } from '../lib/stores/approvalsStore.ts';
import type { ClientPhase } from '../lib/ws/wsClient.ts';
import { uiStore } from './uiStore.ts';

export function gatewayReadout(phase: ClientPhase): { text: string; status: string } {
  switch (phase) {
    case 'connected':
      return { text: 'CONNECTED', status: 'ok' };
    case 'connecting':
    case 'discovering':
    case 'reconnect-wait':
      return { text: 'RECONNECTING', status: 'degraded' };
    case 'auth-rejected':
      return { text: 'AUTH FAULT', status: 'fault' };
    case 'no-broker':
      return { text: 'NO SIGNAL', status: 'nosignal' };
    default:
      return { text: 'OFF', status: 'nosignal' };
  }
}

export function StatusBar(): ReactNode {
  const phase = useStore(connectionStore, (s) => s.phase);
  const pendingCount = useStore(approvalsStore, (s) => s.order.length);
  const openSettings = useStore(uiStore, (s) => s.openSettings);
  const openPalette = useStore(uiStore, (s) => s.openPalette);
  const readout = gatewayReadout(phase);

  return (
    <header className="ig-statusbar" data-testid="statusbar">
      <span className="ig-engraved">THE-LAST-AIBENDER</span>
      <span className="ig-engraved">
        GATEWAY{' '}
        <span className={`ig-status-${readout.status}`} data-testid="gateway-readout">
          {readout.text}
        </span>
      </span>
      <button
        type="button"
        className="ig-engraved"
        data-testid="statusbar-approvals"
        onClick={() => document.getElementById('ig-approvals')?.scrollIntoView()}
      >
        APPROVALS{' '}
        {pendingCount > 0 ? (
          <span className="ig-attention">{pendingCount}</span>
        ) : (
          <span style={{ color: 'var(--ig-ink-faint)' }}>0</span>
        )}
      </button>
      <span className="ig-statusbar-spacer" />
      <button type="button" className="ig-engraved" onClick={openPalette} data-testid="statusbar-palette">
        ⌘K PALETTE
      </button>
      <span className="ig-engraved">{PROTOCOL_FREEZE}</span>
      <button type="button" className="ig-engraved" onClick={openSettings} data-testid="statusbar-settings">
        SETTINGS
      </button>
    </header>
  );
}
