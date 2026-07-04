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

export interface GatewayBootstrap {
  /** TCP port of the WS server on 127.0.0.1 (1–65535, broker-advertised). */
  readonly port: number;
  /** Per-boot gateway auth token — SECRET, never log, never store [X2]. */
  readonly token: string;
  /** Broker process id (liveness probe input). */
  readonly pid: number;
  /** ISO-8601 broker boot wall-clock. */
  readonly startedAt: string;
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
