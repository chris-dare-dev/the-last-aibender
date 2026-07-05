/**
 * The hooks-contract.md ACCEPTING ENDPOINT (BE-5 source 8; FROZEN-M2
 * contract, FROZEN-M3 acceptance types in @aibender/protocol hooks.ts).
 *
 *   POST http://127.0.0.1:<hooksPort>/hooks/v1/<ACCOUNT_LABEL>
 *
 * Behavior, exactly per the §2 acceptance table:
 *   - well-formed body with `hook_event_name` + `session_id` → 204 (incl.
 *     UNKNOWN event names, parked as `unmapped` — the vocabulary-bump rule);
 *   - gating-capable event the floor answers → 200 + HookGatingOutput;
 *   - unknown `<ACCOUNT_LABEL>` segment → 404, never a guess [X2];
 *   - unparseable/malformed body → 400; the session is unaffected.
 *
 * Every ACCEPTED post is normalized into the events store (source `hooks`).
 * `PermissionRequest` posts are additionally RELAYED into the ApprovalBroker
 * hook-floor queue slot (the M2 approvals.spec.ts slot row): the relay slice
 * comes from the frozen `hookFloorRelayInput`, the broker maps the native
 * session id to a harness id where the composition knows one (injectable
 * mapper), and the `approval-request` fans out with source `hook-floor`
 * (ws-protocol.md §10.1).
 *
 * FLOOR POSTURE (hooks-contract.md §4 + its T3 flag): default `observe` —
 * the relay lands in the inbox but the HTTP answer is ALWAYS 204 (no
 * opinion; the native permission flow proceeds). `escalate` waits up to
 * `floorTimeoutMs` for a human decision and answers 200
 * `{permissionDecision}` when one arrives in time, else 204. The CLI-side
 * interpretation of 200 bodies is UNVERIFIED on the real host (T3
 * pending-owner) — observe stays the default until that proof lands.
 *
 * The collector answers fast and never applies backpressure to sessions
 * (fire-and-forget posture; inserts are synchronous SQLite writes).
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  DEFAULT_HOOKS_PORT,
  HOOKS_PORT_ENV_VAR,
  HOOK_PATH_PREFIX,
  ackForHookOutcome,
  ackForSessionStart,
  hookFloorRelayInput,
  validateHookPost,
  x4AutomationRouteFor,
  type AcceptedHookPost,
  type HookAck,
  type HookGatingOutput,
  type HookSessionStartOutput,
  type WorkstreamHookRouting,
} from '@aibender/protocol';
import type { EventsTableStore } from '@aibender/schema';

import type { ApprovalBroker } from '../../kernel/approvals.js';
import { normalizeAcceptedHookPost } from './normalize.js';

/**
 * The slice of the kernel ApprovalBroker this endpoint consumes —
 * structurally the M2 broker's `request` verb, so the composition root wires
 * the real `createApprovalBroker` handle straight in.
 */
export type HookFloorApprovalPort = Pick<ApprovalBroker, 'request'>;

export const HOOKS_SERVER_HOST = '127.0.0.1';

/** Max accepted body bytes (a hook stdin JSON is small; 1 MiB is generous). */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

/**
 * SEC-3 [X2]: the header a hook POST presents its per-boot token in. Distinct
 * from the WS gateway token — this is the hooks-endpoint credential SI-3
 * injects into each account's hook settings at install time. Case-insensitive
 * per HTTP; node lowercases header names.
 */
export const HOOK_TOKEN_HEADER = 'x-aibender-hook-token';

/**
 * SEC-3: constant-time token check for the hooks endpoint. Loopback binding
 * (127.0.0.1) already blocks off-host traffic, but ANY other local process
 * (a malicious npm dep, a browser extension, a compromised sibling) can reach
 * 127.0.0.1:<port> and POST crafted PermissionRequest/SessionEnd/PreCompact
 * events into the approval floor + session ledger. A per-install token the local
 * attacker does not know closes that spoofing gap. Missing/non-string presented
 * value is always false; length mismatch does a dummy compare (no length leak).
 */
function hookTokenMatches(expected: string, req: IncomingMessage): boolean {
  const raw = req.headers[HOOK_TOKEN_HEADER];
  // A repeated header arrives as string[]; only a single exact value is valid.
  const presented = typeof raw === 'string' ? raw : undefined;
  if (presented === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface HooksServerStats {
  readonly accepted: number;
  readonly rejected400: number;
  readonly rejected404: number;
  /** SEC-3: posts rejected 401 for a missing/wrong per-boot hook token. */
  readonly rejected401: number;
  readonly rowsInserted: number;
  readonly relaysRaised: number;
  readonly gatingAnswered: number;
  /** M4 [X4]: accepted posts routed to a registered automation handler. */
  readonly automationRouted: number;
  /** M4 [X4]: SessionStart posts answered 200 + injection. */
  readonly injectionsAnswered: number;
}

export interface HooksServer {
  readonly state: 'listening' | 'port-in-use';
  readonly port: number;
  readonly url: string;
  stats(): HooksServerStats;
  close(): Promise<void>;
}

export interface HooksServerOptions {
  readonly events: EventsTableStore;
  /** The M2 ApprovalBroker (or its testkit double). Absent → no relay. */
  readonly approvals?: HookFloorApprovalPort;
  /**
   * Native → harness session id mapping (resume-ledger lookup at
   * composition). Unmapped ids relay as the native id — the approvals wire
   * sessionId charset admits both (hooks-contract.md §7).
   */
  readonly sessionIdOfNative?: (nativeSessionId: string) => string | undefined;
  /** `observe` (default, T3-safe) or `escalate` (answers 200 in time). */
  readonly floorPosture?: 'observe' | 'escalate';
  /** Escalate-mode decision window, ms. Default 3000 (short hook timeout). */
  readonly floorTimeoutMs?: number;
  /**
   * BE-7 [X4] automation routing (hooks-contract.md §7.1, M4 — BE-7's
   * narrow wiring into this endpoint, registered by the composition root;
   * BE-ORCH reviews). Frozen semantics: `onSessionEnd`/`onPreCompact` are
   * POST-ACK fire-and-forget — the 204 is written FIRST and a slow or
   * throwing handler can never stall or fail a session; `onSessionStart` is
   * the ONE handler whose output rides the response, raced against
   * {@link HooksServerOptions.sessionStartTimeoutMs} and answered
   * `200 + HookSessionStartOutput` via the frozen `ackForSessionStart`
   * discipline (empty context degrades to 204). Absent slots keep the M3
   * events-store-only behavior exactly.
   */
  readonly workstreams?: WorkstreamHookRouting;
  /** SessionStart injection deadline, ms. Default 2000 (§4 floor pattern). */
  readonly sessionStartTimeoutMs?: number;
  /** Default: AIBENDER_HOOKS_PORT env, else 4319. Tests pass 0. */
  readonly port?: number;
  readonly nowMs?: () => number;
  /**
   * SEC-3 [X2]: the hooks-endpoint token. When set, EVERY POST must present it
   * in the {@link HOOK_TOKEN_HEADER} header (constant-time checked) or the
   * request is rejected `401` BEFORE any body parse, normalization,
   * events-store insert, or approval-floor relay — so a local process that
   * reaches 127.0.0.1:<port> without the token can no longer inject false
   * PermissionRequest/SessionEnd/PreCompact events. LIFECYCLE (hooks-contract.md
   * §4.2): this is a STABLE per-install secret — SI-3 mints it once and writes
   * it 0600 to `$AIBENDER_HOME/hook-token`, injecting the matching header into
   * each account's hook settings; the composition root (BE-MAIN) READS that
   * same file at boot and passes the value here. It does NOT mint per boot — a
   * per-boot value would never match the header baked into the on-disk hook
   * settings. Kept DISTINCT from the per-boot WS gateway token. ABSENT keeps
   * the M2–M6 behavior exactly (loopback-only, no header) for back-compat; the
   * guard is a no-op then. The loopback bind (127.0.0.1) is preserved either
   * way — the token is defense-in-depth against LOCAL-process spoofing, not
   * network exposure.
   */
  readonly authToken?: string;
}

function envPort(): number | undefined {
  const raw = process.env[HOOKS_PORT_ENV_VAR];
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined;
}

export async function startHooksServer(options: HooksServerOptions): Promise<HooksServer> {
  const nowMs = options.nowMs ?? Date.now;
  const floorPosture = options.floorPosture ?? 'observe';
  const floorTimeoutMs = options.floorTimeoutMs ?? 3000;
  const sessionStartTimeoutMs = options.sessionStartTimeoutMs ?? 2000;
  const stats = {
    accepted: 0,
    rejected400: 0,
    rejected404: 0,
    rejected401: 0,
    rowsInserted: 0,
    relaysRaised: 0,
    gatingAnswered: 0,
    automationRouted: 0,
    injectionsAnswered: 0,
  };
  let receipt = 0;

  /**
   * [X4] §7.1: race the SessionStart handler against the injection deadline.
   * A slow, rejecting, or throwing handler degrades to `undefined` (→ 204) —
   * the <50 ms ack posture only stretches for a handler that answers fast.
   */
  const raceSessionStart = async (
    accepted: AcceptedHookPost,
  ): Promise<HookSessionStartOutput | undefined> => {
    const handler = options.workstreams?.onSessionStart;
    if (handler === undefined) return undefined;
    stats.automationRouted += 1;
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), sessionStartTimeoutMs);
        timer.unref?.();
      });
      return await Promise.race([
        Promise.resolve(handler.call(options.workstreams, accepted)).catch(() => undefined),
        deadline,
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  /** [X4] §7.1: POST-ACK fire-and-forget slots (throws logged-and-swallowed). */
  const routePostAck = (accepted: AcceptedHookPost): void => {
    const routing = options.workstreams;
    if (routing === undefined) return;
    const route = x4AutomationRouteFor(accepted);
    try {
      if (route === 'SessionEnd' && routing.onSessionEnd !== undefined) {
        stats.automationRouted += 1;
        routing.onSessionEnd(accepted);
      } else if (route === 'PreCompact' && routing.onPreCompact !== undefined) {
        stats.automationRouted += 1;
        routing.onPreCompact(accepted);
      }
    } catch {
      // A throwing handler can never fail a session (§7.1) — the ack is
      // already on the wire; nothing to answer differently.
    }
  };

  /** Relay a PermissionRequest into the hook-floor slot; maybe await it. */
  const relayPermissionRequest = async (
    accepted: Parameters<typeof hookFloorRelayInput>[0],
  ): Promise<HookGatingOutput | undefined> => {
    if (options.approvals === undefined) return undefined;
    if (accepted.hookEventName !== 'PermissionRequest') return undefined;
    const relay = hookFloorRelayInput(accepted);
    if (relay === undefined) return undefined; // no tool_name → nothing to summarize [X2]
    const sessionId =
      options.sessionIdOfNative?.(relay.nativeSessionId) ?? relay.nativeSessionId;
    let handle;
    try {
      handle = options.approvals.request({
        source: 'hook-floor',
        // Identifier-free summary built from the tool name alone [X2].
        summary: `hook floor: session requests ${relay.toolName}`,
        accountLabel: relay.accountLabel,
        sessionId,
        toolName: relay.toolName,
        ...(relay.toolUseId !== undefined ? { toolUseId: relay.toolUseId } : {}),
        ...(floorPosture === 'escalate' ? { ttlMs: floorTimeoutMs } : {}),
      });
    } catch {
      return undefined; // a refusing broker must never break the session
    }
    stats.relaysRaised += 1;
    if (floorPosture === 'observe') return undefined; // inbox only; 204

    // Escalate: the broker's own ttl resolves the race (expired → 204).
    const resolution = await handle.resolution;
    if (resolution.outcome === 'allowed') {
      return { permissionDecision: 'allow' };
    }
    if (resolution.outcome === 'denied') {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: resolution.note ?? 'denied by harness policy floor',
      };
    }
    return undefined; // expired / superseded → no opinion
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HOOK_BODY_BYTES) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        // SEC-3: token gate FIRST — before method/path/body. A local process
        // that reaches the loopback socket without the token learns nothing
        // (no path/label oracle) and cannot inject a spoofed event.
        if (options.authToken !== undefined && !hookTokenMatches(options.authToken, req)) {
          stats.rejected401 += 1;
          res.writeHead(401);
          res.end();
          return;
        }

        const url = req.url ?? '';
        const method = req.method ?? 'GET';

        if (method !== 'POST' || !url.startsWith(HOOK_PATH_PREFIX)) {
          stats.rejected404 += 1;
          res.writeHead(404);
          res.end();
          return;
        }
        const segment = url.slice(HOOK_PATH_PREFIX.length);
        if (segment.length === 0 || segment.includes('/')) {
          stats.rejected404 += 1;
          res.writeHead(404);
          res.end();
          return;
        }

        let body: unknown;
        if (overflowed) {
          body = undefined; // → malformed-body 400
        } else {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = undefined; // unparseable = the same 400 class
          }
        }

        const outcome = validateHookPost(segment, body);
        let gating: HookGatingOutput | undefined;
        let injection: HookSessionStartOutput | undefined;

        if (outcome.ok) {
          stats.accepted += 1;
          receipt += 1;
          const insert = options.events.insert(
            normalizeAcceptedHookPost({
              accepted: outcome.accepted,
              tsMs: nowMs(),
              receipt,
            }),
          );
          if (insert.inserted) stats.rowsInserted += 1;
          gating = await relayPermissionRequest(outcome.accepted);
          // [X4] §7.1: the ONE handler whose output rides the response.
          if (x4AutomationRouteFor(outcome.accepted) === 'SessionStart') {
            injection = await raceSessionStart(outcome.accepted);
          }
        } else if (outcome.httpStatus === 404) {
          stats.rejected404 += 1;
        } else {
          stats.rejected400 += 1;
        }

        // ackForSessionStart owns the injection discipline (only on accepted
        // SessionStart posts; empty context → 204); gating keeps priority on
        // gating-capable events — SessionStart is not one, so the branches
        // never both produce a 200 body for the same post.
        const ack: HookAck =
          injection !== undefined
            ? ackForSessionStart(outcome, injection)
            : ackForHookOutcome(outcome, gating);
        if (ack.status === 200) {
          if (injection !== undefined) {
            stats.injectionsAnswered += 1;
          } else {
            stats.gatingAnswered += 1;
          }
          const payload = JSON.stringify(ack.body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload);
        } else {
          res.writeHead(ack.status);
          res.end();
        }

        // [X4] §7.1 POST-ACK fire-and-forget: SessionEnd / PreCompact route
        // AFTER the answer is on the wire — a slow handler stalls nothing.
        if (outcome.ok) routePostAck(outcome.accepted);
      })().catch(() => {
        res.destroy();
      });
    });
  });

  const port = options.port ?? envPort() ?? DEFAULT_HOOKS_PORT;
  const bound = await new Promise<'listening' | 'port-in-use'>((resolve) => {
    server.once('error', () => resolve('port-in-use'));
    server.listen(port, HOOKS_SERVER_HOST, () => resolve('listening'));
  });

  if (bound === 'port-in-use') {
    return {
      state: 'port-in-use',
      port: 0,
      url: '',
      stats: () => ({ ...stats }),
      close: async () => {
        /* nothing bound */
      },
    };
  }

  const address = server.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : port;

  return {
    state: 'listening',
    port: boundPort,
    url: `http://${HOOKS_SERVER_HOST}:${String(boundPort)}`,
    stats: () => ({ ...stats }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
