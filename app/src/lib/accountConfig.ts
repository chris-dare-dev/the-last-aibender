/**
 * FE-1 / FE-4 — the account-registry SYNC seam.
 *
 * THE BUG (FE-1, HIGH): the configured Claude accounts were resolved ONCE at
 * the composition root and stored in a module closure that nothing re-read.
 * When the broker restarted with a newly-provisioned account (e.g. MAX_C),
 * the FE kept rendering the stale seed set across every account surface
 * (picker, channel panels, observability chips, pipelines, workstreams) until
 * a manual page reload — silently losing an account (an [X1] multi-account
 * regression, and a fail-closed-discipline violation: an account must never
 * disappear from the operator's view).
 *
 * THE FIX: the configured set now lives in a REACTIVE store
 * ({@link accountConfigStore}). This module re-reads the bootstrap carrier and
 * re-syncs the store on the SAME `onBrokerRestart` trigger that resets every
 * watermark — so a restarted broker's new account becomes visible
 * cockpit-wide, no reload. {@link installAccountRegistrySync} wires the boot
 * sync + the restart re-sync in one call.
 *
 * FE-4 (LOW): when the resolved list is empty (absent / unreadable / all
 * non-form labels dropped), the registry falls back to its seed set. That
 * fallback used to be SILENT — an operator who later repaired the bootstrap
 * file had no signal anything was wrong. This module LOGS the fallback reason
 * at info/debug so the fallback is observable; once FE-1's re-sync lands a
 * repaired file self-heals on the next restart anyway.
 *
 * [X2]: nothing identifier-bearing is logged. The label list is already
 * FORM-validated (`MAX_<X>`/`ENT`) fail-closed by
 * {@link configuredClaudeAccountsFromBootstrap}; the token never reaches here.
 */

import { isClaudeAccountLabel } from '@aibender/protocol';
import { setConfiguredClaudeAccounts } from './accountRegistry.ts';
import type { BootstrapProvider } from './bootstrap.ts';
import { discoverGateway } from './bootstrap.ts';
import { consoleLogger, type Logger } from './log.ts';

/** Why a sync attempt resolved the way it did (FE-4 observability). */
export type AccountSyncReason =
  | 'bootstrap' // the carrier advertised ≥1 sanctioned label — registry updated
  | 'shim' // the browser-dev global supplied the set
  | 'empty' // carrier present but advertised an empty / all-dropped list → seed
  | 'absent'; // no carrier / unreadable / torn bootstrap → seed (fail-closed)

export interface AccountSyncResult {
  readonly reason: AccountSyncReason;
  /** How many sanctioned labels were applied (0 when the seed stayed). */
  readonly count: number;
}

/** Optional injection seam (tests pin the shim + logger). */
export interface AccountSyncOptions {
  logger?: Logger;
  /** Reads a `window.AIBENDER_CLAUDE_ACCOUNTS`-style dev shim. */
  readShim?: () => unknown;
  /**
   * Fires after EVERY sync (boot + each restart re-sync) with the outcome —
   * the observable seam for the async restart path (tests await it; callers
   * may surface a "registry re-synced" toast). Errors in the callback are
   * swallowed so an observer never destabilizes the sync.
   */
  onSynced?: (result: AccountSyncResult) => void;
}

function defaultShim(): unknown {
  return (globalThis as { AIBENDER_CLAUDE_ACCOUNTS?: unknown }).AIBENDER_CLAUDE_ACCOUNTS;
}

/**
 * One sync pass: re-read the bootstrap carrier (fail-closed [X2]), apply the
 * advertised set to the reactive registry when it has ≥1 sanctioned label,
 * else the dev shim, else leave the seed in place. Returns WHY, and logs the
 * fallback reason (FE-4). Never throws — discovery is guarded and a failure
 * falls back to the seed like any other empty result.
 *
 * Used at boot AND on every broker restart (FE-1). Because the target is a
 * reactive store, a successful re-sync propagates to every account surface.
 */
export async function syncAccountRegistry(
  provider: BootstrapProvider,
  options: AccountSyncOptions = {},
): Promise<AccountSyncResult> {
  const logger = options.logger ?? consoleLogger;
  const readShim = options.readShim ?? defaultShim;
  const emit = (result: AccountSyncResult): AccountSyncResult => {
    try {
      options.onSynced?.(result);
    } catch {
      // An observer error never destabilizes the sync.
    }
    return result;
  };

  // Discover the bootstrap DIRECTLY (not via configuredClaudeAccountsFromBootstrap)
  // so we can tell "no carrier field at all" (absent) from "carrier present but
  // every label dropped fail-closed" (empty) — the two collapse to `[]`
  // otherwise, losing the FE-4 fallback-reason distinction. `discoverGateway`
  // is contractually non-throwing (absent/unreadable/torn all resolve to
  // `undefined`), so a rejected provider surfaces here as `undefined` → absent
  // → seed fallback: the cockpit never destabilizes on a bad read.
  const bootstrap = await discoverGateway(provider);
  const carrier = bootstrap?.claudeAccounts; // undefined = no `claudeAccounts` field

  // Re-validate each label FORM fail-closed [X2] (mirror of
  // configuredClaudeAccountsFromBootstrap): a non-form entry never survives.
  const advertised = carrier?.filter((label) => isClaudeAccountLabel(label)) ?? [];
  if (advertised.length > 0) {
    setConfiguredClaudeAccounts(advertised, 'bootstrap');
    logger.debug('account registry synced from bootstrap carrier', {
      count: advertised.length,
    });
    return emit({ reason: 'bootstrap', count: advertised.length });
  }

  const shim = readShim();
  if (Array.isArray(shim) && shim.length > 0) {
    setConfiguredClaudeAccounts(shim, 'shim');
    logger.debug('account registry synced from dev shim', { count: shim.length });
    return emit({ reason: 'shim', count: shim.length });
  }

  // Fallback to seed — FE-4: say WHY, so a repaired file / a still-absent
  // carrier is observable to the operator (no identifier is logged).
  //   absent  → no `claudeAccounts` field (or the bootstrap was unreadable/torn);
  //   empty   → the field was present but every label was dropped fail-closed.
  const reason: AccountSyncReason = carrier === undefined ? 'absent' : 'empty';
  // Ensure the store reflects the seed even if a prior sync had set a set and a
  // later restart lost the carrier (fail-closed to the known-good seed).
  setConfiguredClaudeAccounts([], 'seed');
  logger.warn('account registry fell back to seed set', { reason });
  return emit({ reason, count: 0 });
}

/**
 * FE-1 composition wiring: sync once at boot, then RE-SYNC on every broker
 * restart (boot-identity change). Returns a dispose that unsubscribes the
 * restart listener. The `subscribe` shape is the {@link GatewayClient} surface
 * (structurally typed so tests drive a fake).
 */
export interface RestartTrigger {
  subscribe(listener: { onBrokerRestart?(): void }): () => void;
}

export function installAccountRegistrySync(
  client: RestartTrigger,
  provider: BootstrapProvider,
  options: AccountSyncOptions = {},
): { boot: Promise<AccountSyncResult>; dispose: () => void } {
  const boot = syncAccountRegistry(provider, options);
  const dispose = client.subscribe({
    onBrokerRestart() {
      // The registry may need to GROW (new account) or SHRINK (deprovisioned);
      // re-read the carrier the broker just rewrote. Errors are swallowed by
      // syncAccountRegistry — a re-sync failure never destabilizes the cockpit.
      void syncAccountRegistry(provider, options);
    },
  });
  return { boot, dispose };
}
