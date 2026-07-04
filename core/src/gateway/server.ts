/**
 * Gateway WS server — BE-3 FULL (M2) slice (plan §4/BE-3, blueprint §2;
 * contract of record: docs/contracts/ws-protocol.md, FROZEN-M2).
 *
 * Carried forward from M1 (unchanged semantics):
 *  - one WebSocket server on ws://127.0.0.1:<random port>; per-boot random
 *    auth token presented at connect time (query param or bearer header);
 *    bad token answers `bad-auth` on control and closes 1008;
 *  - bootstrap discovery file (./bootstrap.ts) written on start, removed on
 *    close (ownership-checked);
 *  - the control channel over the BE-1 kernel port (./kernel.ts) through the
 *    FROZEN validators — launch · resume · kill · status; `approve` answers
 *    `verb-reserved` (retired-as-reserved at the M2 freeze);
 *  - the §7 error envelope for everything that cannot be answered as a
 *    correlated control response.
 *
 * NEW at M2 (this slice):
 *  - binary PTY frame streaming over the BE-2 host port (./ports.ts):
 *    OUTPUT fan-out with the SPIKE-D ack-watermark discipline
 *    (./ptyStream.ts — bounded buffers, slow-consumer backpressure via
 *    producer pause/resume, per-consumer delivery windows), INPUT frames
 *    written through, `pty-resize` propagated, `pty-replay-request` served
 *    from the retained window;
 *  - `transcript.<sid>` channels projecting the kernel SDK message stream
 *    (./transcriptProjector.ts) into the frozen payload union;
 *  - the `approvals` channel bridging BE-2's ApprovalBroker: request +
 *    resolution fan-out to every client, decisions relayed in, idempotent
 *    double-decisions answered `approval-not-pending` (§7 — a NORMAL race);
 *  - `quota` / `events` / `context-graph` as validated pass-through
 *    publishers on the handle (their SOURCES land with BE-5/BE-6 at M3);
 *  - JSON reconnect-replay across every broker→client fan-out channel
 *    (./journal.ts): per-(boot, channel) seq, bounded journals, one
 *    `replay-request` per channel on reconnect, original seqs replayed.
 *
 * Every M2 port is OPTIONAL; absent ports degrade to empty-stub behavior:
 *  - no ptyHost      → all pty traffic answers `session-not-found`;
 *  - no approvals    → decisions answer `approval-not-pending` (nothing can
 *                      be pending), no requests ever fan out;
 *  - no transcripts  → transcript channels journal nothing (replay from 0 is
 *                      a legal no-op).
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CHANNEL,
  REQUEST_ID_RE,
  decodePtyFrame,
  encodePtyFrame,
  isReplayableChannel,
  isSessionIdSegment,
  ptyChannel,
  sessionIdOfChannel,
  streamForChannel,
  transcriptChannel,
  validateApprovalsClientMessage,
  validateApprovalsServerMessage,
  validateContextGraphTouch,
  validateControlRequest,
  validateEnvelope,
  validateJsonReplayRequest,
  validatePtyClientMessage,
  validateQuotaSnapshot,
  validateTranscriptPayload,
  type ChannelName,
  type ContextGraphTouch,
  type ControlRequest,
  type ControlResponse,
  type ControlResult,
  type ErrorCode,
  type ErrorDetail,
  type ErrorPayload,
  type PtyClientMessage,
  type QuotaSnapshot,
} from '@aibender/protocol';
import { createLineScrubber, createLogger, type Logger } from '@aibender/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  bootstrapPath,
  removeBootstrapFile,
  writeBootstrapFile,
  type BootstrapPathOptions,
} from './bootstrap.js';
import { JournalSet } from './journal.js';
import { isKernelVerbError, type GatewayKernel } from './kernel.js';
import type {
  ApprovalBrokerPort,
  GatewayPtyHost,
  GatewayPtySession,
  TranscriptSource,
  Unsubscribe,
} from './ports.js';
import {
  PtySessionStream,
  type PtyConsumerHandle,
  type PtyDeliverySink,
  type PtyFlowControlOptions,
} from './ptyStream.js';
import { createTranscriptProjector, type TranscriptProjector } from './transcriptProjector.js';
import { newBootToken, tokensMatch } from './token.js';

// ---------------------------------------------------------------------------
// Options / handle
// ---------------------------------------------------------------------------

/** Loopback only — the frontend never reaches the broker off-host (blueprint §2). */
export const GATEWAY_HOST = '127.0.0.1';

/**
 * Max inbound WS message. Comfortably covers the largest legal binary INPUT
 * frame (16-byte header + 64-byte sid + 1 MiB payload cap, §5) and all JSON
 * traffic; a misbehaving client cannot balloon broker memory.
 */
export const GATEWAY_MAX_INBOUND_BYTES = 4 * 1024 * 1024;

export interface GatewayOptions extends BootstrapPathOptions {
  /** The BE-1 kernel port the control verbs drive. */
  readonly kernel: GatewayKernel;
  /** BE-2 ptyHost port — binary PTY streaming (absent → no pty sessions). */
  readonly ptyHost?: GatewayPtyHost;
  /** BE-2 ApprovalBroker port (absent → every decision is not-pending). */
  readonly approvals?: ApprovalBrokerPort;
  /** Kernel SDK message tap feeding transcript.<sid> (absent → silent). */
  readonly transcripts?: TranscriptSource;
  /** PTY flow-control tuning (mechanism frozen, values BE-3 config, §6). */
  readonly flowControl?: Partial<PtyFlowControlOptions>;
  /** JSON reconnect-replay journal bound (per channel, §8). */
  readonly replayJournal?: { readonly maxEntriesPerChannel?: number };
  /** Structured logger; defaults to @aibender/shared createLogger(). */
  readonly logger?: Logger;
  /** Wall clock for `startedAt` (tests). */
  readonly clock?: () => Date;
  /** Skip writing the bootstrap file (tests that exercise the server alone). */
  readonly writeBootstrap?: boolean;
}

export interface GatewayHandle {
  /** OS-assigned port on 127.0.0.1. */
  readonly port: number;
  /** ws://127.0.0.1:<port> */
  readonly url: string;
  /** Per-boot auth token (secret — also in the 0600 bootstrap file). */
  readonly token: string;
  /** Absolute bootstrap file path (written unless writeBootstrap:false). */
  readonly bootstrapPath: string;
  /** Currently-open authenticated connections (tests/observability). */
  connectionCount(): number;
  /**
   * M3-source pass-throughs (plan BE-3: quota/events/context-graph channels
   * as validated stubs until BE-5/BE-6 land). Each broadcast is journaled
   * (replayable §8) and fanned out to every connected client. Invalid
   * payloads THROW (RangeError) — the broker never fabricates or forwards a
   * frame that fails its own frozen validators (never a wire condition).
   */
  publishQuota(snapshot: QuotaSnapshot): void;
  publishContextTouch(touch: ContextGraphTouch): void;
  /** `events` payload union is DRAFT until M3 — pushed as an opaque envelope. */
  publishEvent(payload: Readonly<Record<string, unknown>>): void;
  /** Stop accepting, close clients (1001), remove the owned bootstrap file. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface Connection {
  readonly socket: WebSocket;
  /** Per-connection outbound seq (CONTROL only — fan-out channels use the journal seq, §2). */
  readonly seqByChannel: Map<ChannelName, number>;
  authenticated: boolean;
}

/** One live PTY session as wired into this gateway. */
interface PtyEntry {
  readonly session: GatewayPtySession;
  readonly stream: PtySessionStream;
  readonly consumers: Map<Connection, PtyConsumerHandle>;
  readonly unsubscribes: Unsubscribe[];
}

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_GOING_AWAY = 1001;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// startGateway
// ---------------------------------------------------------------------------

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const kernel = options.kernel;
  const clock = options.clock ?? (() => new Date());
  const token = newBootToken();
  // [X2]: the per-boot token is a known secret value — scrub it out of every
  // outbound error message and every log line, unconditionally.
  const scrub = createLineScrubber({ secretValues: [token] });
  const baseLogger = options.logger ?? createLogger();
  const log: Logger = {
    debug: (msg, fields) => baseLogger.debug(scrub(msg), fields),
    info: (msg, fields) => baseLogger.info(scrub(msg), fields),
    warn: (msg, fields) => baseLogger.warn(scrub(msg), fields),
    error: (msg, fields) => baseLogger.error(scrub(msg), fields),
  };

  const httpServer: Server = createServer((_req, res) => {
    // Non-upgrade HTTP is not a surface of this gateway.
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: GATEWAY_MAX_INBOUND_BYTES,
  });

  const connections = new Set<Connection>();
  /** Per-(boot, channel) fan-out journals — the §8 replay watermark axis. */
  const journals = new JournalSet(options.replayJournal?.maxEntriesPerChannel);
  const ptyEntries = new Map<string, PtyEntry>();
  const projectors = new Map<string, TranscriptProjector>();
  const portUnsubscribes: Unsubscribe[] = [];
  let closed = false;

  // ---- outbound ------------------------------------------------------------

  const writeEnvelope = (conn: Connection, channel: ChannelName, seq: number, payload: unknown): void => {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload }));
  };

  /** CONTROL-channel send with the per-connection seq counter (§2). */
  const sendControl = (conn: Connection, payload: unknown): void => {
    const seq = conn.seqByChannel.get(CHANNEL.CONTROL) ?? 0;
    conn.seqByChannel.set(CHANNEL.CONTROL, seq + 1);
    writeEnvelope(conn, CHANNEL.CONTROL, seq, payload);
  };

  /**
   * Fan-out broadcast on a replayable channel: journal first (assigning the
   * per-(boot, channel) seq), then one identical envelope to every client.
   */
  const broadcast = (channel: ChannelName, payload: unknown): void => {
    if (closed) return;
    const seq = journals.journalFor(channel).append(payload);
    const text = JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload });
    for (const conn of connections) {
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(text);
    }
  };

  const pushError = (
    conn: Connection,
    code: ErrorCode,
    message: string,
    extras: { correlatesTo?: string; channel?: ChannelName; retryable?: boolean } = {},
  ): void => {
    const payload: ErrorPayload = {
      kind: 'error',
      code,
      message: scrub(message),
      retryable: extras.retryable ?? false,
      ...(extras.correlatesTo !== undefined ? { correlatesTo: extras.correlatesTo } : {}),
      ...(extras.channel !== undefined ? { channel: extras.channel } : {}),
    };
    sendControl(conn, payload);
  };

  const respond = (conn: Connection, response: ControlResponse): void => {
    sendControl(conn, response);
  };

  const respondError = (conn: Connection, id: string, detail: ErrorDetail): void => {
    respond(conn, {
      kind: 'result',
      id,
      ok: false,
      error: { ...detail, message: scrub(detail.message) },
    });
  };

  // ---- control dispatch ------------------------------------------------------

  const runVerb = async (request: ControlRequest): Promise<ControlResult> => {
    switch (request.kind) {
      case 'launch': {
        const launched = await kernel.launch(request.params);
        return { verb: 'launch', sessionId: launched.sessionId, state: launched.state };
      }
      case 'resume': {
        const resumed = await kernel.resume({
          sessionId: request.params.sessionId,
          fork: request.params.fork ?? false,
          // ICR-0004: thread the next-user-prompt through to the kernel port.
          ...(request.params.prompt !== undefined ? { prompt: request.params.prompt } : {}),
        });
        return {
          verb: 'resume',
          sessionId: resumed.sessionId,
          state: resumed.state,
          ...(resumed.forkedFrom !== undefined ? { forkedFrom: resumed.forkedFrom } : {}),
        };
      }
      case 'kill': {
        const killed = await kernel.kill({
          sessionId: request.params.sessionId,
          mode: request.params.mode ?? 'graceful',
        });
        return { verb: 'kill', sessionId: killed.sessionId, state: killed.state };
      }
      case 'status': {
        const sessions = await kernel.status(request.params?.sessionId);
        return { verb: 'status', sessions };
      }
    }
  };

  const handleControlPayload = (conn: Connection, rawPayload: unknown): void => {
    const parsed = validateControlRequest(rawPayload);
    if (!parsed.ok) {
      // §4: a request that carries a well-formed id is answered by exactly one
      // correlated response — even when the rest of it failed validation.
      const candidateId = isRecord(rawPayload) ? rawPayload['id'] : undefined;
      if (typeof candidateId === 'string' && REQUEST_ID_RE.test(candidateId)) {
        respondError(conn, candidateId, {
          code: parsed.code,
          message: parsed.message,
          retryable: false,
        });
      } else {
        pushError(conn, parsed.code, parsed.message, { channel: CHANNEL.CONTROL });
      }
      return;
    }

    const request = parsed.value;
    void runVerb(request).then(
      (result) => {
        respond(conn, { kind: 'result', id: request.id, ok: true, result });
      },
      (error: unknown) => {
        if (isKernelVerbError(error)) {
          respondError(conn, request.id, {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          });
          return;
        }
        // Unexpected kernel failure: log broker-side, answer a GENERIC
        // message — never echo arbitrary error text onto the wire [X2].
        log.error('kernel verb threw a non-KernelVerbError', {
          verb: request.kind,
          detail: error instanceof Error ? scrub(error.message) : String(typeof error),
        });
        respondError(conn, request.id, {
          code: 'internal',
          message: `internal broker error while handling ${request.kind}`,
          retryable: false,
        });
      },
    );
  };

  // ---- PTY slice (ws-protocol.md §5/§6) ---------------------------------------

  const ptySinkFor = (conn: Connection, sessionId: string): PtyDeliverySink => ({
    deliver: (streamOffset, data) => {
      if (conn.socket.readyState !== conn.socket.OPEN) return;
      conn.socket.send(encodePtyFrame({ type: 'output', sessionId, streamOffset, payload: data }), {
        binary: true,
      });
    },
  });

  const wirePtySession = (sessionId: string, session: GatewayPtySession): void => {
    if (!isSessionIdSegment(sessionId)) {
      log.error('pty host announced a malformed session id — ignored', {});
      return;
    }
    if (ptyEntries.has(sessionId)) {
      log.warn('pty host re-announced a live session — ignored', { sessionId });
      return;
    }
    const stream = new PtySessionStream(session, options.flowControl ?? {});
    const entry: PtyEntry = { session, stream, consumers: new Map(), unsubscribes: [] };
    entry.unsubscribes.push(
      session.onOutput((chunk) => {
        // A cap breach throws PtyBufferOverflowError into the host's emit
        // path ON PURPOSE: it means pause() was ignored — a broker bug that
        // must fail loudly, never a wire condition (§6).
        stream.push(chunk);
      }),
    );
    entry.unsubscribes.push(
      session.onExit(() => {
        // Trailing output stays replayable until the gateway closes; the
        // backpressure levers become no-ops (the producer is gone).
        stream.markExited();
      }),
    );
    ptyEntries.set(sessionId, entry);
  };

  if (options.ptyHost !== undefined) {
    portUnsubscribes.push(options.ptyHost.onSession(wirePtySession));
  }

  const handlePtyMessage = (
    conn: Connection,
    channel: ChannelName,
    sessionId: string,
    message: PtyClientMessage,
  ): void => {
    const entry = ptyEntries.get(sessionId);
    if (entry === undefined) {
      pushError(conn, 'session-not-found', 'no such pty session', { channel });
      return;
    }
    switch (message.kind) {
      case 'pty-resize': {
        entry.session.resize(message.cols, message.rows);
        return;
      }
      case 'pty-ack': {
        const consumer = entry.consumers.get(conn);
        if (consumer === undefined) {
          // Never attached ⇒ delivered offset is 0: watermark 0 is a legal
          // stale no-op, anything higher is beyond the delivered offset (§6).
          if (message.watermark > 0) {
            pushError(conn, 'watermark-out-of-range', 'ack watermark is beyond the delivered offset', {
              channel,
            });
          }
          return;
        }
        const result = consumer.ack(message.watermark);
        if (!result.ok) pushError(conn, result.code, result.message, { channel });
        return;
      }
      case 'pty-replay-request': {
        const existing = entry.consumers.get(conn);
        if (existing !== undefined) {
          const result = existing.replayFrom(message.fromWatermark);
          if (!result.ok) pushError(conn, result.code, result.message, { channel });
          return;
        }
        // First replay-request from this connection = the ATTACH verb: the
        // retained window replays from the watermark, then live flow follows.
        const attached = entry.stream.attach(ptySinkFor(conn, sessionId), message.fromWatermark);
        if (!attached.ok) {
          pushError(conn, attached.code, attached.message, { channel });
          return;
        }
        entry.consumers.set(conn, attached.consumer);
        return;
      }
    }
  };

  // ---- approvals slice (ws-protocol.md §10) -----------------------------------

  if (options.approvals !== undefined) {
    const approvals = options.approvals;
    portUnsubscribes.push(
      approvals.onRequest((request) => {
        // Defensive freeze-validation of broker-built payloads: an invalid
        // request is a BE-2 bug — drop it loudly, never put it on the wire.
        const checked = validateApprovalsServerMessage(request);
        if (!checked.ok) {
          log.error('approval broker produced an invalid approval-request — dropped', {
            detail: scrub(checked.message),
          });
          return;
        }
        broadcast(CHANNEL.APPROVALS, checked.value);
      }),
    );
    portUnsubscribes.push(
      approvals.onResolved((resolved) => {
        const checked = validateApprovalsServerMessage(resolved);
        if (!checked.ok) {
          log.error('approval broker produced an invalid approval-resolved — dropped', {
            detail: scrub(checked.message),
          });
          return;
        }
        broadcast(CHANNEL.APPROVALS, checked.value);
      }),
    );
  }

  const handleApprovalsPayload = (conn: Connection, payload: unknown): void => {
    const decision = validateApprovalsClientMessage(payload);
    if (!decision.ok) {
      pushError(conn, decision.code, decision.message, { channel: CHANNEL.APPROVALS });
      return;
    }
    const approvals = options.approvals;
    if (approvals === undefined) {
      // No broker attached ⇒ nothing can be pending. Same NORMAL-race answer
      // as a late decision — deliberately not `internal` (§7).
      pushError(conn, 'approval-not-pending', 'approval is not pending (already resolved or expired)', {
        channel: CHANNEL.APPROVALS,
      });
      return;
    }
    void approvals.decide(decision.value).then(
      (outcome) => {
        if (outcome === 'not-pending') {
          // Idempotent double-decision handling: the first decision applied
          // (and fans out approval-resolved via onResolved); every later one
          // lands here. The decider converges via the fan-out.
          pushError(conn, 'approval-not-pending', 'approval is not pending (already resolved or expired)', {
            channel: CHANNEL.APPROVALS,
          });
        }
      },
      (error: unknown) => {
        log.error('approval broker decide() rejected', {
          detail: error instanceof Error ? scrub(error.message) : String(typeof error),
        });
        pushError(conn, 'internal', 'internal broker error while applying an approval decision', {
          channel: CHANNEL.APPROVALS,
        });
      },
    );
  };

  // ---- transcript slice (ws-protocol.md §9) -------------------------------------

  if (options.transcripts !== undefined) {
    portUnsubscribes.push(
      options.transcripts.onMessage((sessionId, raw) => {
        if (!isSessionIdSegment(sessionId)) {
          log.error('transcript source used a malformed session id — dropped', {});
          return;
        }
        let projector = projectors.get(sessionId);
        if (projector === undefined) {
          projector = createTranscriptProjector(sessionId);
          projectors.set(sessionId, projector);
        }
        for (const payload of projector.project(raw)) {
          // Defensive freeze-validation before the wire (projector bugs must
          // never ship an off-contract frame).
          const checked = validateTranscriptPayload(payload, sessionId);
          if (!checked.ok) {
            log.error('projected transcript payload failed frozen validation — dropped', {
              sessionId,
              detail: scrub(checked.message),
            });
            continue;
          }
          broadcast(transcriptChannel(sessionId), checked.value);
        }
      }),
    );
  }

  // ---- JSON reconnect-replay (ws-protocol.md §8) --------------------------------

  const handleReplayRequest = (conn: Connection, channel: ChannelName, payload: unknown): void => {
    const parsed = validateJsonReplayRequest(payload, channel);
    if (!parsed.ok) {
      pushError(conn, parsed.code, parsed.message, { channel });
      return;
    }
    const replay = journals.journalFor(channel).replayFrom(parsed.value.fromSeq);
    if (!replay.ok) {
      pushError(conn, replay.code, replay.message, { channel });
      return;
    }
    // Retained envelopes re-send in order with their ORIGINAL seq values;
    // live flow (with higher seqs) continues after them.
    for (const entry of replay.entries) {
      writeEnvelope(conn, channel, entry.seq, entry.payload);
    }
  };

  // ---- routing ---------------------------------------------------------------

  const routeTextFrame = (conn: Connection, text: string): void => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      pushError(conn, 'bad-envelope', 'text frame is not valid JSON');
      return;
    }
    const envelope = validateEnvelope(decoded);
    if (!envelope.ok) {
      pushError(conn, envelope.code, envelope.message);
      return;
    }
    const { channel, payload } = envelope.value;

    if (channel === CHANNEL.CONTROL) {
      handleControlPayload(conn, payload);
      return;
    }

    const sid = sessionIdOfChannel(channel);
    if (sid !== undefined && channel.startsWith('pty.')) {
      const message = validatePtyClientMessage(payload, sid);
      if (!message.ok) {
        pushError(conn, message.code, message.message, { channel });
        return;
      }
      handlePtyMessage(conn, channel, sid, message.value);
      return;
    }

    // Broker→client fan-out channels. Registered client payloads (§3):
    // the generic replay-request (every replayable channel) and approval
    // decisions (approvals only). Everything else is a channel-policy reject.
    if (isRecord(payload) && payload['kind'] === 'replay-request' && isReplayableChannel(channel)) {
      handleReplayRequest(conn, channel, payload);
      return;
    }
    if (channel === CHANNEL.APPROVALS) {
      handleApprovalsPayload(conn, payload);
      return;
    }
    pushError(conn, 'bad-request', `channel ${channel} accepts no client payloads`, {
      channel,
    });
  };

  const routeBinaryFrame = (conn: Connection, bytes: Uint8Array): void => {
    const frame = decodePtyFrame(bytes);
    if (!frame.ok) {
      pushError(conn, frame.code, frame.message);
      return;
    }
    const channel = ptyChannel(frame.value.sessionId);
    if (frame.value.type !== 'input') {
      // OUTPUT frames are broker→client only (§5) — a client sending one is
      // malformed traffic, not a session condition.
      pushError(conn, 'bad-request', 'clients send INPUT frames only on pty channels', { channel });
      return;
    }
    const entry = ptyEntries.get(frame.value.sessionId);
    if (entry === undefined) {
      pushError(conn, 'session-not-found', 'no such pty session', { channel });
      return;
    }
    entry.session.write(frame.value.payload);
  };

  // ---- connection lifecycle ----------------------------------------------------

  const presentedToken = (request: IncomingMessage): string | undefined => {
    const url = new URL(request.url ?? '/', `ws://${GATEWAY_HOST}`);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery !== null) return fromQuery;
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return undefined;
  };

  const dropConnection = (conn: Connection): void => {
    connections.delete(conn);
    // Detach this connection's PTY consumers: the release floor recomputes,
    // possibly releasing bytes a slow consumer was pinning (§6).
    for (const entry of ptyEntries.values()) {
      const consumer = entry.consumers.get(conn);
      if (consumer !== undefined) {
        consumer.detach();
        entry.consumers.delete(conn);
      }
    }
  };

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const conn: Connection = { socket, seqByChannel: new Map(), authenticated: false };

    socket.on('error', (error: Error) => {
      log.warn('gateway socket error', { detail: scrub(error.message) });
    });

    const presented = presentedToken(request);
    if (!tokensMatch(token, presented)) {
      // Frozen requirement (ws-protocol.md §1): answer bad-auth, close 1008.
      pushError(conn, 'bad-auth', 'missing or invalid gateway token', {
        channel: CHANNEL.CONTROL,
      });
      socket.close(CLOSE_POLICY_VIOLATION, 'bad-auth');
      return;
    }

    conn.authenticated = true;
    connections.add(conn);
    socket.on('close', () => {
      dropConnection(conn);
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!conn.authenticated || closed) return;
      const bytes = toUint8(data);
      if (isBinary) {
        routeBinaryFrame(conn, bytes);
      } else {
        routeTextFrame(conn, Buffer.from(bytes).toString('utf8'));
      }
    });
  });

  wss.on('error', (error: Error) => {
    log.error('gateway server error', { detail: scrub(error.message) });
  });

  // ---- bind + advertise ----------------------------------------------------

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    // Port 0 = OS-assigned random port, bound to loopback only.
    httpServer.listen(0, GATEWAY_HOST, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const port = address.port;
  const url = `ws://${GATEWAY_HOST}:${port}`;
  const advertisedPath = bootstrapPath(options);

  if (options.writeBootstrap !== false) {
    try {
      await writeBootstrapFile(
        { port, token, pid: process.pid, startedAt: clock().toISOString() },
        options,
      );
    } catch (error) {
      // A gateway nobody can discover is useless — fail the boot loudly.
      await shutdownServers();
      throw error;
    }
  }

  log.info('gateway listening', { port, bootstrap: advertisedPath });

  async function shutdownServers(): Promise<void> {
    for (const unsubscribe of portUnsubscribes.splice(0)) unsubscribe();
    for (const entry of ptyEntries.values()) {
      for (const unsubscribe of entry.unsubscribes.splice(0)) unsubscribe();
    }
    ptyEntries.clear();
    for (const conn of connections) {
      conn.socket.close(CLOSE_GOING_AWAY, 'gateway shutdown');
    }
    connections.clear();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      await shutdownServers();
      if (options.writeBootstrap !== false) {
        await removeBootstrapFile(token, options);
      }
      log.info('gateway closed', { port });
    })();
    return closePromise;
  };

  return {
    port,
    url,
    token,
    bootstrapPath: advertisedPath,
    connectionCount: () => connections.size,
    publishQuota: (snapshot) => {
      const checked = validateQuotaSnapshot(snapshot);
      if (!checked.ok) {
        // The broker never fabricates a snapshot (plan §9.2 BE-6 negative
        // row) — an invalid one here is a programmer error, not wire traffic.
        throw new RangeError(`refusing to publish an invalid quota snapshot: ${checked.message}`);
      }
      broadcast(CHANNEL.QUOTA, checked.value);
    },
    publishContextTouch: (touch) => {
      const checked = validateContextGraphTouch(touch);
      if (!checked.ok) {
        throw new RangeError(`refusing to publish an invalid context touch: ${checked.message}`);
      }
      broadcast(CHANNEL.CONTEXT_GRAPH, checked.value);
    },
    publishEvent: (payload) => {
      if (!isRecord(payload)) {
        throw new RangeError('events payloads must be JSON objects (union is DRAFT until M3)');
      }
      broadcast(CHANNEL.EVENTS, payload);
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
