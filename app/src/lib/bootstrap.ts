/**
 * FE-side reader for the gateway bootstrap/discovery file
 * (docs/contracts/bootstrap-file.md, FROZEN-M2).
 *
 * The contract's §5 note applies: FE-2 owns its OWN reader against the prose
 * — the shape below mirrors `core/src/gateway/bootstrap.ts` but is
 * deliberately re-implemented (the Node implementation is not importable in
 * the WKWebView bundle, and the prose is the contract).
 *
 * Reader discipline (§4):
 *  - absent / unreadable / malformed all mean the SAME thing: "no broker
 *    advertised" — never an error dialog, never a retry storm;
 *  - clients never write/touch/delete the file (the actual fs read happens
 *    behind {@link BootstrapProvider} — the Tauri command in v0);
 *  - (token, pid, startedAt) is the BOOT IDENTITY: any change between reads
 *    means broker restart → every reconnect-replay watermark is invalid
 *    (ws-protocol.md §8).
 *
 * [X2]: `token` is a per-boot SECRET. It never leaves the client closure,
 * never lands in a zustand store, and never appears in a log line.
 */

import { isClaudeAccountLabel } from '@aibender/protocol';

export interface GatewayBootstrap {
  /** TCP port of the WS server on 127.0.0.1 (1–65535, broker-advertised). */
  readonly port: number;
  /** Per-boot gateway auth token — SECRET, never log, never store [X2]. */
  readonly token: string;
  /** Broker process id (liveness probe input). */
  readonly pid: number;
  /** ISO-8601 broker boot wall-clock. */
  readonly startedAt: string;
  /**
   * OPTIONAL (ICR-0014): the sanctioned placeholder labels of the Claude
   * accounts the broker discovered from `infra/profiles/*.profile.json` — the
   * [X1] account-registry carrier. `MAX_<X>`/`ENT` FORM labels ONLY; never a
   * real identity or a machine-local path [X2]. Absent means "no configured
   * set advertised" — the cockpit falls back to its seed set. NOT part of the
   * boot-identity triple. Read it with
   * {@link configuredClaudeAccountsFromBootstrap}, which re-validates each
   * label FORM and drops non-form entries fail-closed.
   */
  readonly claudeAccounts?: readonly string[];
}

/** The boot-identity triple (bootstrap-file.md §2). */
export interface BootIdentity {
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Structural validator — total over `unknown`; a torn/foreign file never
 * throws (mirrors `isGatewayBootstrap` field constraints in the contract).
 */
export function isGatewayBootstrap(value: unknown): value is GatewayBootstrap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const port = v['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  const token = v['token'];
  if (typeof token !== 'string' || token.length === 0) return false;
  const pid = v['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return false;
  const startedAt = v['startedAt'];
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return false;
  // ICR-0014: `claudeAccounts` is OPTIONAL. Absent is valid (back-compat with
  // every M1–M6 file). Present must be an array of strings — a foreign
  // non-array or a non-string element makes the WHOLE file "no broker
  // advertised" (a reader never partially trusts a torn/foreign body). The
  // per-element FORM check is applied by
  // {@link configuredClaudeAccountsFromBootstrap}, fail-closed [X2].
  const claudeAccounts = v['claudeAccounts'];
  if (claudeAccounts !== undefined) {
    if (!Array.isArray(claudeAccounts)) return false;
    if (!claudeAccounts.every((entry) => typeof entry === 'string')) return false;
  }
  return true;
}

export function bootIdentityOf(b: GatewayBootstrap): BootIdentity {
  return { token: b.token, pid: b.pid, startedAt: b.startedAt };
}

/** True when the broker is the SAME boot (watermarks stay valid). */
export function sameBootIdentity(a: BootIdentity, b: BootIdentity): boolean {
  return a.token === b.token && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Connect URL per ws-protocol.md §1: the browser WebSocket API cannot set
 * headers, so the per-boot token rides `?token=` on the loopback-only URL.
 */
export function gatewayWsUrl(b: GatewayBootstrap): string {
  return `ws://127.0.0.1:${b.port}/?token=${encodeURIComponent(b.token)}`;
}

/**
 * Discovery seam. Resolves the PARSED (but unvalidated) JSON content of the
 * bootstrap file, or `undefined` when nothing is advertised. Implementations:
 * the Tauri `read_bootstrap` command (v0), a dev-shim global, test fakes.
 * Implementations must never throw — resolve `undefined` instead.
 */
export type BootstrapProvider = () => Promise<unknown>;

/**
 * One discovery pass: provider → structural validation. Absent, unreadable
 * and malformed all collapse to `undefined` ("no broker advertised").
 */
export async function discoverGateway(
  provider: BootstrapProvider,
): Promise<GatewayBootstrap | undefined> {
  let raw: unknown;
  try {
    raw = await provider();
  } catch {
    return undefined; // unreadable ⇒ no broker advertised (§4.1)
  }
  return isGatewayBootstrap(raw) ? raw : undefined;
}

/**
 * ICR-0014 — the FE consumer of the account-registry carrier. One discovery
 * pass, then extract the CONFIGURED Claude-account placeholder labels from
 * `claudeAccounts`, FAIL-CLOSED per [X2]: every element is re-validated by
 * {@link isClaudeAccountLabel} (the `MAX_<X>`/`ENT` FORM) and a non-form entry
 * (email, real name, `MAX_AB`, lowercase `max_c`, a fixed backend label, a
 * non-string) is DROPPED. Returns an empty array when nothing is advertised or
 * nothing survives — the composition root then leaves the FE registry on its
 * seed set. Never throws (a torn/foreign file collapses to "no broker
 * advertised" upstream). The label list feeds `setConfiguredClaudeAccounts`.
 */
export async function configuredClaudeAccountsFromBootstrap(
  provider: BootstrapProvider,
): Promise<readonly string[]> {
  const bootstrap = await discoverGateway(provider);
  const advertised = bootstrap?.claudeAccounts;
  if (advertised === undefined) return [];
  return advertised.filter((label) => isClaudeAccountLabel(label));
}
