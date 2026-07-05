/**
 * THE {@link SessionIdResolver} implementation (BE-7; ws-protocol.md §15.2,
 * plan §4/BE-7 item 6) — the native → harness session-id mapping the
 * composition root injects into every native-id-bearing feed at M4:
 * the graphfeed's `resolveSessionId` seam
 * (core/src/collector/graphfeed/hookTouches.ts) and the hooks approvals
 * relay's `sessionIdOfNative` (core/src/collector/hooks/server.ts). Wiring
 * it via composeBroker flips the frozen §12 relay pin: harness ids take
 * over wherever the ledger knows the native id.
 *
 * Frozen semantics honored exactly:
 *   - return the HARNESS id where the ledger knows the native id — the
 *     lineage store first (`session_node.byNativeSessionId`, covers
 *     reconciled externals too), then the resume ledger
 *     (`resume_ledger.native_session_id`, covers kernel sessions whose
 *     lineage node has not been recorded — one database, sqlite-ddl.md §8.1
 *     reason 3);
 *   - return the INPUT VERBATIM to relay an unknown native id (external
 *     sessions stay visible under their native id until the reconciler
 *     registers them; charset-validated downstream, never rewritten);
 *   - return undefined to DROP only inputs that are not usable ids at all
 *     (empty string — the feed never guesses).
 *
 * READ-ONLY by construction: two lookups, no write path [X4].
 */

import type { SessionIdResolver } from '@aibender/protocol';
import type { LineageStore, ResumeLedgerStore } from '@aibender/schema';

export interface SessionIdResolverOptions {
  readonly store: LineageStore;
  /** The SAME resume ledger the kernel writes (kernel database). */
  readonly resumeLedger?: ResumeLedgerStore;
}

export function createSessionIdResolver(options: SessionIdResolverOptions): SessionIdResolver {
  return (nativeSessionId) => {
    if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
      return undefined; // not an id — DROP, never guess
    }
    const node = options.store.nodes.byNativeSessionId(nativeSessionId);
    if (node !== undefined) return node.id;
    if (options.resumeLedger !== undefined) {
      const row = options.resumeLedger
        .list()
        .find((candidate) => candidate.nativeSessionId === nativeSessionId);
      if (row !== undefined) return row.id;
    }
    return nativeSessionId; // relay verbatim (the frozen §15.2 rule)
  };
}
