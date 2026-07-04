/**
 * Composition root for the imperative islands (FE-2, M2 DoD wiring).
 *
 * This is the ONE place where islands, lib adapters and the gateway client
 * meet: chrome mounts islands through the islandRegistry seam and never
 * imports app/src/islands (directory-ownership rule); island modules never
 * touch the WebSocket. Imported only by main.tsx.
 *
 *  - terminal — one attended `pty.<sid>` session in xterm via
 *    {@link mountTerminalIsland}; the PTY port is the conduit adapter
 *    (lib/islands/terminalPort.ts). Unmount detaches via the serialize-addon
 *    snapshot; a re-mount restores it and wire-replays from the final ack
 *    (spike-a clause 5 / ws-protocol.md §6).
 *  - transcript — the React {@link TranscriptIsland} over the per-session
 *    feed registry (lib/islands/transcriptFeeds.ts), hydrated by bind.ts
 *    from validated `transcript.<sid>` payloads.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import { registerIsland } from '../chrome/islandRegistry.ts';
import { mountTerminalIsland } from '../islands/terminal/index.ts';
import type { TerminalDetachState } from '../islands/terminal/index.ts';
import { TranscriptIsland } from '../islands/transcript/index.ts';
import { terminalPortForConduit } from '../lib/islands/terminalPort.ts';
import { transcriptFeeds } from '../lib/islands/transcriptFeeds.ts';
import type { GatewayClient } from '../lib/ws/wsClient.ts';

/**
 * Register the M2 islands against a client. Returns an unregister function
 * (tests; the app calls this once at boot and never tears it down).
 */
export function registerAppIslands(client: GatewayClient): () => void {
  // Detach snapshots per session: reattaching restores scrollback locally,
  // then replays retained OUTPUT from the final ack — never below it.
  const detachStates = new Map<string, TerminalDetachState>();

  const unregisterTerminal = registerIsland('terminal', {
    mount(host, { sessionId }) {
      if (sessionId === undefined) return () => undefined;
      const conduit = client.openPty(sessionId);
      const restore = detachStates.get(sessionId);
      const handle = mountTerminalIsland({
        container: host,
        port: terminalPortForConduit(conduit),
        ...(restore !== undefined ? { restore } : {}),
      });
      return () => {
        // Keep the conduit open (the byte axis outlives the mount);
        // detach() sends the final ack and captures the snapshot.
        detachStates.set(sessionId, handle.detach());
      };
    },
  });

  const unregisterTranscript = registerIsland('transcript', {
    mount(host, { sessionId }) {
      if (sessionId === undefined) return () => undefined;
      const root = createRoot(host);
      root.render(
        <StrictMode>
          <TranscriptIsland feed={transcriptFeeds.feedFor(sessionId)} />
        </StrictMode>,
      );
      return () => root.unmount();
    },
  });

  return () => {
    unregisterTerminal();
    unregisterTranscript();
    detachStates.clear();
  };
}
