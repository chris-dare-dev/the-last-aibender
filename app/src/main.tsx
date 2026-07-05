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
import { registerPipelines } from './features/pipelines/index.ts';
import { registerWorkstreams } from './features/workstreams/index.ts';
import { registerGraphIsland } from './islands/graph/index.ts';
import { setConfiguredClaudeAccounts } from './lib/accountRegistry.ts';
import { configuredClaudeAccountsFromBootstrap } from './lib/bootstrap.ts';
import { bindClientToStores } from './lib/stores/bind.ts';
import { nativeBootstrapProvider, notifyNative } from './lib/native/tauriBridge.ts';
import { GatewayClient } from './lib/ws/wsClient.ts';

const client = new GatewayClient({ bootstrapProvider: nativeBootstrapProvider });
bindClientToStores(client);
registerAppIslands(client);
// FE-4 graph island (M4): registers the 'graph' slot (reachable through the
// work-surface GRAPH view toggle), binds the context-graph channel per
// mount, warm-starts from contextGraphStore.recent, rebuilds the scene on
// broker restart, and registers the 'focus context graph' palette verb.
registerGraphIsland(client);
// FE-5 observability feature (M3): binds the events channel, occupies the
// chrome's 'observability' island slot, registers the palette verb. The app
// never disposes it — the returned teardown is for tests.
registerObservability(client);
// FE-6 workstream lineage (M4): binds the workstream channel, occupies the
// chrome's 'workstreams' island slot (left zone dock), registers the palette
// verb; the merge sender is detected structurally on the client.
registerWorkstreams(client);
// FE-6 pipelines (M5): binds the pipelines channel, occupies the chrome's
// 'pipelines' island slot (the center-work BUILDER view — DESIGN.md §4.1),
// registers the "open pipelines" palette verb; the six-verb sender
// (sendPipelineMessage) is detected structurally on the client. Catalog +
// run snapshots hydrate on the first connect via the PIPELINES replay-from-
// zero default.
registerPipelines(client);

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

/**
 * [X1] account registry (ICR-0013/ICR-0014): the cockpit enumerates the
 * CONFIGURED Claude accounts, never a hardcoded five. The AUTHORITATIVE source
 * is the broker's bootstrap-file carrier (`claudeAccounts` — the accounts it
 * discovered from infra/profiles/*.profile.json). We read it ONCE, pre-render,
 * over the same discovery provider the WS client uses, so the picker / channel
 * panels / decks render the right N accounts from first paint (no flash, no
 * re-render). Fail-closed [X2]: `configuredClaudeAccountsFromBootstrap` drops
 * every non-form label. Fallbacks, in order: (1) the bootstrap carrier;
 * (2) a browser-dev shim on `window.AIBENDER_CLAUDE_ACCOUNTS`; (3) the seed
 * set baked into the registry. `setConfiguredClaudeAccounts` re-normalizes and
 * ignores an empty list, so an absent carrier simply leaves the seed in place.
 */
async function configureAccountRegistry(): Promise<void> {
  try {
    const advertised = await configuredClaudeAccountsFromBootstrap(nativeBootstrapProvider);
    if (advertised.length > 0) {
      setConfiguredClaudeAccounts(advertised);
      return;
    }
  } catch {
    // Discovery never throws by contract; guard anyway — fall through to the
    // dev shim / seed set rather than blocking the cockpit boot.
  }
  const shim = (globalThis as { AIBENDER_CLAUDE_ACCOUNTS?: unknown }).AIBENDER_CLAUDE_ACCOUNTS;
  if (Array.isArray(shim)) setConfiguredClaudeAccounts(shim);
}

void configureAccountRegistry().finally(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <Chrome client={client} />
    </StrictMode>,
  );
});
