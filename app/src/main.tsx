/**
 * SPA entry (FE-2). Boot order:
 *   1. theme tokens (generated) + chrome styles — token-locked visuals;
 *   2. one GatewayClient — bootstrap-file discovery through the Tauri
 *      command (or the dev shim outside the shell), reconnect-replay
 *      watermarks, bounded buffers;
 *   3. store binding (rAF-batched projections);
 *   4. island registration (composition root — chrome mounts through the
 *      registry seam and never imports app/src/islands);
 *   5. React root: the cockpit chrome.
 *
 * v0 runs aibender-core SEPARATELY (LaunchAgent/manual); the shell's sidecar
 * wiring is PREPARED but not flipped — see src-tauri/README.md.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './chrome/theme/tokens.css';
import './chrome/chrome.css';
import { Chrome } from './chrome/Chrome.tsx';
import { registerAppIslands } from './composition/registerIslands.tsx';
import { registerObservability } from './features/observability/index.ts';
import { bindClientToStores } from './lib/stores/bind.ts';
import { nativeBootstrapProvider, notifyNative } from './lib/native/tauriBridge.ts';
import { GatewayClient } from './lib/ws/wsClient.ts';

const client = new GatewayClient({ bootstrapProvider: nativeBootstrapProvider });
bindClientToStores(client);
registerAppIslands(client);
// FE-5 observability feature (M3): binds the events channel, occupies the
// chrome's 'observability' island slot, registers the palette verb. The app
// never disposes it — the returned teardown is for tests.
registerObservability(client);

// Native affordance glue: approval arrivals raise a system notification
// (tray/notification only — never a streaming path, blueprint §2).
client.subscribe({
  onMessage(message) {
    if (message.kind === 'approvals' && message.payload.kind === 'approval-request') {
      void notifyNative('Approval wanted', message.payload.summary);
    }
  },
});

client.start();

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('missing #root element');

createRoot(rootEl).render(
  <StrictMode>
    <Chrome client={client} />
  </StrictMode>,
);
