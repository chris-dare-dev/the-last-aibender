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

import { createServer, type Server } from 'node:http';

import {
  DEFAULT_HOOKS_PORT,
  HOOKS_PORT_ENV_VAR,
  HOOK_PATH_PREFIX,
  ackForHookOutcome,
  hookFloorRelayInput,
  validateHookPost,
  type HookAck,
  type HookGatingOutput,
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

export interface HooksServerStats {
  readonly accepted: number;
  readonly rejected400: number;
  readonly rejected404: number;
  readonly rowsInserted: number;
  readonly relaysRaised: number;
  readonly gatingAnswered: number;
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
  /** Default: AIBENDER_HOOKS_PORT env, else 4319. Tests pass 0. */
  readonly port?: number;
  readonly nowMs?: () => number;
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
  const stats = {
    accepted: 0,
    rejected400: 0,
    rejected404: 0,
    rowsInserted: 0,
    relaysRaised: 0,
    gatingAnswered: 0,
  };
  let receipt = 0;

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
        } else if (outcome.httpStatus === 404) {
          stats.rejected404 += 1;
        } else {
          stats.rejected400 += 1;
        }

        const ack: HookAck = ackForHookOutcome(outcome, gating);
        if (ack.status === 200) {
          stats.gatingAnswered += 1;
          const payload = JSON.stringify(ack.body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload);
          return;
        }
        res.writeHead(ack.status);
        res.end();
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
