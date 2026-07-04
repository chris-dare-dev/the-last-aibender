/**
 * Settings — a raised dialog in the palette geometry family. Terse
 * instrument rows: gateway facts (identifier-free — port/pid/boot time,
 * NEVER the token [X2]), protocol pin, broker run mode, motion state.
 */

import { useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { PROTOCOL_FREEZE, PROTOCOL_VERSION } from '@aibender/protocol';
import { connectionStore } from '../lib/stores/connectionStore.ts';
import { useGatewayClient } from './clientContext.tsx';
import { usePrefersReducedMotion } from './phosphor.tsx';
import { uiStore } from './uiStore.ts';

function Row({ k, v, testId }: { k: string; v: string; testId?: string }): ReactNode {
  return (
    <div className="ig-settings-row">
      <span className="ig-settings-key ig-engraved">{k}</span>
      <span className="ig-settings-value" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}

export function SettingsView(): ReactNode {
  const open = useStore(uiStore, (s) => s.settingsOpen);
  const closeSettings = useStore(uiStore, (s) => s.closeSettings);
  const conn = useStore(connectionStore, (s) => s);
  const client = useGatewayClient();
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeSettings]);

  if (!open) return null;

  return (
    <>
      <div className="ig-scrim" onClick={closeSettings} />
      <div className="ig-settings" role="dialog" aria-label="settings" data-testid="settings-view">
        <header className="ig-panel-header">
          <span className="ig-engraved">SETTINGS</span>
          <button type="button" className="ig-btn ig-panel-readout" onClick={closeSettings}>
            CLOSE
          </button>
        </header>
        <Row k="GATEWAY" v={conn.phase.toUpperCase()} testId="settings-phase" />
        <Row k="PORT" v={conn.port === undefined ? '—' : String(conn.port)} />
        <Row k="BROKER PID" v={conn.pid === undefined ? '—' : String(conn.pid)} />
        <Row k="BROKER BOOT" v={conn.startedAt ?? '—'} />
        <Row k="PROTOCOL" v={`${PROTOCOL_VERSION} · ${PROTOCOL_FREEZE}`} />
        <Row k="BROKER MODE" v="EXTERNAL (V0) · SIDECAR PREPARED" />
        <Row k="MOTION" v={reducedMotion ? 'REDUCED (SYSTEM)' : 'MECHANICAL'} />
        <Row k="THEME" v="INSTRUMENT GRADE · LOCKED" />
        <Row
          k="VIOLATIONS"
          v={`${conn.violationCount} dropped · ${conn.duplicateDrops} dup · ${conn.brokerRestarts} restarts`}
        />
        <div className="ig-settings-row">
          <span className="ig-settings-key ig-engraved">DISCOVERY</span>
          <button
            type="button"
            className="ig-btn"
            data-testid="settings-rediscover"
            onClick={() => client?.retry()}
          >
            RE-RUN
          </button>
        </div>
      </div>
    </>
  );
}
