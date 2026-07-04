/**
 * Gateway WS server — BE-3 M1 slice ONLY (plan §4/BE-3, blueprint §2).
 *
 * In scope now:
 *  - one WebSocket server on ws://127.0.0.1:<random port>;
 *  - per-boot random auth token; unauthenticated connections answer
 *    `bad-auth` on the control channel and are closed (frozen requirement;
 *    the richer handshake MESSAGE is DRAFT until M2);
 *  - bootstrap discovery file (./bootstrap.ts) written on start, removed on
 *    close (ownership-checked);
 *  - the control channel wired to the BE-1 kernel port (./kernel.ts) through
 *    the FROZEN @aibender/protocol validators — launch · resume · kill ·
 *    status; `approve` answers `verb-reserved`;
 *  - the §7 error envelope for everything that cannot be answered as a
 *    correlated control response.
 *
 * Explicitly NOT here (M2, do not "helpfully" add): PTY byte streaming,
 * transcript/events/quota/approvals payloads, ack-watermark flow control,
 * reconnect replay. Inbound traffic addressed at those surfaces is answered
 * with the closest frozen error code (see routeTextFrame/routeBinaryFrame).
 *
 * AUTH TRANSPORT (M1): the client presents the bootstrap token either as
 * `?token=<token>` on the connection URL or as an `Authorization: Bearer`
 * header. Query-param transport exists because the browser WebSocket API
 * (WKWebView, FE-2) cannot set headers; the server is loopback-only and the
 * token is per-boot. The M2 handshake message may supersede this — the
 * bad-auth behavior is the frozen part.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CHANNEL,
  REQUEST_ID_RE,
  decodePtyFrame,
  ptyChannel,
  sessionIdOfChannel,
  streamForChannel,
  validateControlRequest,
  validateEnvelope,
  validatePtyClientMessage,
  type ChannelName,
  type ControlRequest,
  type ControlResponse,
  type ControlResult,
  type Envelope,
  type ErrorCode,
  type ErrorDetail,
  type ErrorPayload,
} from '@aibender/protocol';
import { createLineScrubber, createLogger, type Logger } from '@aibender/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  bootstrapPath,
  removeBootstrapFile,
  writeBootstrapFile,
  type BootstrapPathOptions,
} from './bootstrap.js';
import { isKernelVerbError, type GatewayKernel } from './kernel.js';
import { newBootToken, tokensMatch } from './token.js';

// ---------------------------------------------------------------------------
// Options / handle
// ---------------------------------------------------------------------------

/** Loopback only — the frontend never reaches the broker off-host (blueprint §2). */
export const GATEWAY_HOST = '127.0.0.1';

/**
 * Max inbound WS message. M1 carries only small JSON control traffic; the
 * bound exists so a misbehaving client cannot balloon broker memory. M2's
 * PTY slice revisits this alongside PTY_FRAME_MAX_PAYLOAD_BYTES.
 */
export const GATEWAY_MAX_INBOUND_BYTES = 4 * 1024 * 1024;

export interface GatewayOptions extends BootstrapPathOptions {
  /** The BE-1 kernel port the control verbs drive. */
  readonly kernel: GatewayKernel;
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
  /** Stop accepting, close clients (1001), remove the owned bootstrap file. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface Connection {
  readonly socket: WebSocket;
  /** Sender-assigned per-channel monotonic seq for OUTBOUND envelopes (§2). */
  readonly seqByChannel: Map<ChannelName, number>;
  authenticated: boolean;
}

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_GOING_AWAY = 1001;

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
  let closed = false;

  // ---- outbound ------------------------------------------------------------

  const sendEnvelope = (conn: Connection, channel: ChannelName, payload: unknown): void => {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    const seq = conn.seqByChannel.get(channel) ?? 0;
    conn.seqByChannel.set(channel, seq + 1);
    const envelope: Envelope = {
      stream: streamForChannel(channel),
      channel,
      seq,
      payload,
    };
    conn.socket.send(JSON.stringify(envelope));
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
    sendEnvelope(conn, CHANNEL.CONTROL, payload);
  };

  const respond = (conn: Connection, response: ControlResponse): void => {
    sendEnvelope(conn, CHANNEL.CONTROL, response);
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
      const candidateId =
        typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
          ? (rawPayload as Record<string, unknown>)['id']
          : undefined;
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
      // Flow-control JSON is a frozen shape — validate it properly, then
      // answer the M1 truth: no PTY sessions exist before the M2 slice.
      const message = validatePtyClientMessage(payload, sid);
      if (!message.ok) {
        pushError(conn, message.code, message.message, { channel });
        return;
      }
      pushError(conn, 'session-not-found', 'no such pty session (pty channels land at M2)', {
        channel,
      });
      return;
    }

    // events / quota / context-graph / transcript.<sid> are broker→client
    // only; approvals is bidirectional but its payloads are DRAFT until M2.
    pushError(conn, 'bad-request', `channel ${channel} accepts no client payloads at M1`, {
      channel,
    });
  };

  const routeBinaryFrame = (conn: Connection, bytes: Uint8Array): void => {
    const frame = decodePtyFrame(bytes);
    if (!frame.ok) {
      pushError(conn, frame.code, frame.message);
      return;
    }
    // Well-formed PTY frame, but no PTY sessions exist before M2.
    pushError(conn, 'session-not-found', 'no such pty session (pty byte streaming lands at M2)', {
      channel: ptyChannel(frame.value.sessionId),
    });
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

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const conn: Connection = { socket, seqByChannel: new Map(), authenticated: false };

    socket.on('error', (error: Error) => {
      log.warn('gateway socket error', { detail: scrub(error.message) });
    });

    const presented = presentedToken(request);
    if (!tokensMatch(token, presented)) {
      // Frozen requirement (ws-protocol.md §1/§8): answer bad-auth, close.
      pushError(conn, 'bad-auth', 'missing or invalid gateway token', {
        channel: CHANNEL.CONTROL,
      });
      socket.close(CLOSE_POLICY_VIOLATION, 'bad-auth');
      return;
    }

    conn.authenticated = true;
    connections.add(conn);
    socket.on('close', () => {
      connections.delete(conn);
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
