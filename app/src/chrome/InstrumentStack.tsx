/**
 * The right-zone channel instrument stack: one panel per CONFIGURED account in
 * registry order (DESIGN.md §2.5 flight-deck principle + ADR-0001 — the user
 * learns where to glance; panels NEVER reflow or reorder in response to DATA;
 * the set changes only when the machine's configured accounts change). [X1]:
 * N Claude accounts + the two fixed backend panels, driven from
 * `deriveChannelReadings` over `accountRegistry()`, never a hardcoded five.
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { deriveChannelReadings } from '../lib/stores/channelHealth.ts';
import { connectionStore } from '../lib/stores/connectionStore.ts';
import { quotaStore } from '../lib/stores/quotaStore.ts';
import { sessionsStore } from '../lib/stores/sessionsStore.ts';
import { consoleLogger } from '../lib/log.ts';
import { ChannelPanel } from './ChannelPanel.tsx';
import { useGatewayClient } from './clientContext.tsx';
import { uiStore } from './uiStore.ts';

export function InstrumentStack(): ReactNode {
  const phase = useStore(connectionStore, (s) => s.phase);
  const quota = useStore(quotaStore, (s) => s.snapshots);
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const focusedChannel = useStore(uiStore, (s) => s.focusedChannel);
  const client = useGatewayClient();

  const readings = deriveChannelReadings({ phase, quota, sessions });

  return (
    <div data-testid="instrument-stack">
      {readings.map((reading) => (
        <ChannelPanel
          key={reading.channel}
          reading={reading}
          focused={focusedChannel === reading.channel}
          onRemediate={(channel, remediation) => {
            if (remediation === 'RECONNECT') {
              client?.retry();
              return;
            }
            // `LMS SERVER START` and friends dispatch through the M3 adapter
            // surface (BE-4); at M2 the affordance exists and logs its intent.
            consoleLogger.debug('remediation requested', { channel, remediation });
          }}
        />
      ))}
    </div>
  );
}
