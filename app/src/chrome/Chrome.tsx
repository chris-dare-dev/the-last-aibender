/**
 * The cockpit root — three fixed zones (DESIGN.md §4.1):
 *   left   fleet (sessions; workstreams/pipelines join via FE-6)
 *   center work surface + THE approval inbox
 *   right  the five channel instruments in slot order
 * plus the status rail, ⌘K palette, and settings dialog. Panel geometry
 * never reflows in response to data — only to the §4.2 breakpoints.
 */

import { useEffect, type ReactNode } from 'react';
import type { GatewayClient } from '../lib/ws/wsClient.ts';
import { ApprovalInbox } from './ApprovalInbox.tsx';
import { builtinCommands, registerCommands } from './commands.ts';
import { ClientProvider } from './clientContext.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { FleetPanel } from './FleetPanel.tsx';
import { InstrumentStack } from './InstrumentStack.tsx';
import { ObservabilityDock } from './ObservabilityDock.tsx';
import { SettingsView } from './SettingsView.tsx';
import { StatusBar } from './StatusBar.tsx';
import { WorkSurface } from './WorkSurface.tsx';

export interface ChromeProps {
  readonly client?: GatewayClient;
}

export function Chrome({ client }: ChromeProps): ReactNode {
  useEffect(() => registerCommands(builtinCommands()), []);

  return (
    <ClientProvider value={client}>
      <div className="ig-app" data-testid="chrome-root">
        <StatusBar />
        <div className="ig-cockpit">
          <aside className="ig-zone ig-zone-left" aria-label="fleet zone">
            <FleetPanel />
          </aside>
          <main className="ig-zone ig-zone-center" aria-label="work zone">
            <WorkSurface />
            <ApprovalInbox />
          </main>
          <aside className="ig-zone ig-zone-right" aria-label="instruments zone">
            <InstrumentStack />
            {/* aggregate gauges below the five channel panels (DESIGN.md §4.1) */}
            <ObservabilityDock />
          </aside>
        </div>
        <CommandPalette />
        <SettingsView />
      </div>
    </ClientProvider>
  );
}
