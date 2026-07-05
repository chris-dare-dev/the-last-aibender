/**
 * The FE-2 gateway client — one multiplexed WebSocket implementing
 * @aibender/protocol (FROZEN-M2) with:
 *
 *  - bootstrap-file discovery (docs/contracts/bootstrap-file.md §4): absent /
 *    unreadable / malformed ⇒ "no broker advertised", a freshness state,
 *    never an error dialog, never a retry storm;
 *  - connect-time token auth (`?token=` — ws-protocol.md §1); a pushed
 *    `bad-auth` fails VISIBLY (phase `auth-rejected`, no reconnect storm);
 *  - JSON reconnect-replay watermarks per replayable channel (ws-protocol.md
 *    §8): per-(boot, channel) seq tracking, `replay-request` with
 *    `fromSeq = lastSeq + 1` on reconnect, duplicate-seq drops so replays
 *    never duplicate rows, full watermark discard on broker-restart
 *    detection via the bootstrap boot identity;
 *  - PTY byte conduits on the streamOffset axis (ptyConduit.ts);
 *  - bounded buffers everywhere — nothing in this client grows unboundedly.
 *
 * [X2]: the gateway token lives only inside this closure. It is never
 * logged, never stored, never emitted through any event.
 */

import {
  CHANNEL,
  ptyChannel,
  type ChannelName,
  type ApprovalDecision,
  type ControlRequest,
  type ControlResult,
  type ErrorCode,
  type ErrorDetail,
  type KillRequest,
  type LaunchRequest,
  type PipelineClientPayload,
  type ResumeRequest,
  type StatusRequest,
  type WorkstreamMergeRequest,
} from '@aibender/protocol';
import {
  bootIdentityOf,
  discoverGateway,
  gatewayWsUrl,
  sameBootIdentity,
  type BootIdentity,
  type BootstrapProvider,
} from '../bootstrap.ts';
import { consoleLogger, type Logger } from '../log.ts';
import {
  replayableChannelOf,
  routeBrokerFrame,
  seqOf,
  type InboundMessage,
  type InboundStage,
} from './inboundRouter.ts';
import { OutboundSeq, encodeEnvelope } from './outbound.ts';
import { PtyConduit } from './ptyConduit.ts';
import {
  WS_OPEN,
  platformTimers,
  platformWsFactory,
  type Timers,
  type WsFactory,
  type WsLike,
} from './types.ts';

export type ClientPhase =
  | 'idle'
  | 'discovering'
  | 'no-broker'
  | 'connecting'
  | 'connected'
  | 'reconnect-wait'
  | 'auth-rejected'
  | 'disposed';

export interface ProtocolViolation {
  readonly code: ErrorCode;
  readonly stage: InboundStage;
}

export interface ClientEvents {
  onPhase?(phase: ClientPhase): void;
  /** Every accepted broker message except PTY byte frames (those go to conduits). */
  onMessage?(message: InboundMessage): void;
  /** A malformed/off-contract frame was dropped (connection unaffected). */
  onViolation?(violation: ProtocolViolation): void;
  /** Boot identity changed: every watermark was discarded; stores must reset. */
  onBrokerRestart?(): void;
  /** A replayed envelope was dropped as already-processed (no duplicate rows). */
  onDuplicateDropped?(channel: ChannelName, seq: number): void;
}

export interface GatewayClientOptions {
  bootstrapProvider: BootstrapProvider;
  wsFactory?: WsFactory;
  timers?: Timers;
  logger?: Logger;
  /** Poll cadence while no broker is advertised (freshness, not a storm). */
  discoveryPollMs?: number;
  /** Socket reconnect backoff. */
  backoff?: { minMs?: number; maxMs?: number; factor?: number };
  requestTimeoutMs?: number;
  /**
   * Static channels replay-requested from seq 0 on the FIRST connection of a
   * broker boot (pulls the retained window, e.g. pending approvals pushed
   * before this window existed, or the events channel's retained read-model
   * snapshots so dashboards hydrate without waiting a publish cycle).
   * Below-floor answers `watermark-out-of-range` which is logged and
   * harmless (ws-protocol.md §8).
   */
  replayFromZeroOnFirstConnect?: readonly ChannelName[];
}

/** A control request whose client-generated id may be auto-assigned. */
type WithOptionalId<T extends { readonly id: string }> = Omit<T, 'id'> & { readonly id?: string };

export type ControlRequestDraft =
  | WithOptionalId<LaunchRequest>
  | WithOptionalId<ResumeRequest>
  | WithOptionalId<KillRequest>
  | WithOptionalId<StatusRequest>;

/** A failed control request (broker answered ok:false). */
export class ControlRequestError extends Error {
  constructor(readonly detail: ErrorDetail) {
    super(`control request failed: ${detail.code} — ${detail.message}`);
    this.name = 'ControlRequestError';
  }
}

interface PendingRequest {
  resolve(result: ControlResult): void;
  reject(err: Error): void;
  timeout: unknown;
}

export class GatewayClient {
  private readonly provider: BootstrapProvider;
  private readonly wsFactory: WsFactory;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly discoveryPollMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly backoffFactor: number;
  private readonly requestTimeoutMs: number;
  private readonly replayFromZero: readonly ChannelName[];

  private phase: ClientPhase = 'idle';
  private ws: WsLike | undefined;
  private identity: BootIdentity | undefined;
  private brokerInfo: { port: number; pid: number; startedAt: string } | undefined;
  private firstConnectOfBoot = true;
  private attempts = 0;
  private pendingTimer: unknown;
  private readonly outSeq = new OutboundSeq();
  private readonly watermarks = new Map<ChannelName, number>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly conduits = new Map<string, PtyConduit>();
  private readonly listeners = new Set<ClientEvents>();
  private requestCounter = 0;

  constructor(options: GatewayClientOptions) {
    this.provider = options.bootstrapProvider;
    this.wsFactory = options.wsFactory ?? platformWsFactory;
    this.timers = options.timers ?? platformTimers;
    this.logger = options.logger ?? consoleLogger;
    this.discoveryPollMs = options.discoveryPollMs ?? 3000;
    this.backoffMinMs = options.backoff?.minMs ?? 500;
    this.backoffMaxMs = options.backoff?.maxMs ?? 15_000;
    this.backoffFactor = options.backoff?.factor ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    // EVENTS joined the default set at M3 (BE-ORCH stewarding, FE-5 request):
    // the retained read-model snapshots replay on the first connect of a
    // broker boot so the observability instruments hydrate immediately.
    // WORKSTREAM + CONTEXT_GRAPH joined at M4 (BE-ORCH stewarding, FE-6/FE-4
    // requests — the exact events-channel precedent): the retained §16.5
    // list/detail snapshots hydrate the lineage view on the first connect of
    // a broker boot, and the retained context-graph touch window warm-starts
    // the graph island's activity read model (bounded + honest — below-floor
    // history answers `watermark-out-of-range`, logged and harmless, §8).
    // PIPELINES joined the default set at M5 (BE-ORCH stewarding, FE-6 M5
    // request — the EVENTS/WORKSTREAM/CONTEXT_GRAPH precedent): the retained
    // §18 catalog snapshot + run/step-status window hydrate the builder
    // palette and the run monitor on the first connect of a broker boot, so
    // the deck reads a live catalog and any in-flight runs without waiting a
    // publish cycle (the golden `pipelines-replay-request-valid` fixture;
    // below-floor history answers `watermark-out-of-range`, logged and
    // harmless, §8).
    this.replayFromZero = options.replayFromZeroOnFirstConnect ?? [
      CHANNEL.APPROVALS,
      CHANNEL.QUOTA,
      CHANNEL.EVENTS,
      CHANNEL.WORKSTREAM,
      CHANNEL.CONTEXT_GRAPH,
      CHANNEL.PIPELINES,
    ];
  }

  // -- observability ---------------------------------------------------------

  get currentPhase(): ClientPhase {
    return this.phase;
  }

  /** Identifier-free broker facts for the settings/status surfaces. */
  get broker(): { port: number; pid: number; startedAt: string } | undefined {
    return this.brokerInfo;
  }

  /** Client-side replay watermark for a channel (tests + diagnostics). */
  watermarkOf(channel: ChannelName): number | undefined {
    return this.watermarks.get(channel);
  }

  subscribe(listener: ClientEvents): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit<K extends keyof ClientEvents>(
    key: K,
    ...args: Parameters<NonNullable<ClientEvents[K]>>
  ): void {
    for (const l of this.listeners) {
      const fn = l[key] as ((...a: unknown[]) => void) | undefined;
      try {
        fn?.(...(args as unknown[]));
      } catch (err) {
        this.logger.error('client listener threw', { event: key, err: String(err) });
      }
    }
  }

  private setPhase(phase: ClientPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('onPhase', phase);
  }

  // -- lifecycle --------------------------------------------------------------

  /** Begin discovery. Idempotent. */
  start(): void {
    if (this.phase !== 'idle') return;
    void this.runDiscovery();
  }

  /** Manual retry from a visible-failure state (auth-rejected / no-broker). */
  retry(): void {
    if (this.phase === 'disposed') return;
    this.clearTimer();
    this.closeSocket();
    void this.runDiscovery();
  }

  dispose(): void {
    this.setPhase('disposed');
    this.clearTimer();
    this.closeSocket();
    this.rejectAllPending(new Error('gateway client disposed'));
    for (const conduit of this.conduits.values()) conduit.close();
    this.conduits.clear();
    this.listeners.clear();
  }

  private clearTimer(): void {
    if (this.pendingTimer !== undefined) {
      this.timers.clear(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }

  private schedule(fn: () => void, ms: number): void {
    this.clearTimer();
    this.pendingTimer = this.timers.set(() => {
      this.pendingTimer = undefined;
      fn();
    }, ms);
  }

  private async runDiscovery(): Promise<void> {
    if (this.phase === 'disposed') return;
    this.setPhase('discovering');
    const bootstrap = await discoverGateway(this.provider);
    if ((this.phase as ClientPhase) === 'disposed') return;
    if (bootstrap === undefined) {
      // "No broker advertised" — a freshness state, re-probed calmly.
      this.setPhase('no-broker');
      this.schedule(() => void this.runDiscovery(), this.discoveryPollMs);
      return;
    }

    const identity = bootIdentityOf(bootstrap);
    if (this.identity !== undefined && !sameBootIdentity(this.identity, identity)) {
      this.handleBrokerRestart();
    }
    this.identity = identity;
    this.brokerInfo = { port: bootstrap.port, pid: bootstrap.pid, startedAt: bootstrap.startedAt };

    this.setPhase('connecting');
    let socket: WsLike;
    try {
      socket = this.wsFactory(gatewayWsUrl(bootstrap));
    } catch (err) {
      this.logger.warn('websocket construction failed', { err: String(err) });
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.attempts = 0;
      this.outSeq.reset();
      this.setPhase('connected');
      this.sendReplayRequests();
    };
    socket.onmessage = (ev) => {
      if (this.ws !== socket) return;
      this.handleFrame(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    };
    socket.onerror = () => {
      // onclose always follows; nothing to do here (and nothing to log
      // beyond debug — error events carry no useful detail in WKWebView).
      this.logger.debug('websocket error event');
    };
    socket.onclose = (ev) => {
      if (this.ws !== socket) return;
      this.ws = undefined;
      this.rejectAllPending(new Error('gateway connection closed'));
      if (this.phase === 'disposed' || this.phase === 'auth-rejected') return;
      this.logger.debug('gateway connection closed', { code: ev.code });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.phase === 'disposed' || this.phase === 'auth-rejected') return;
    this.setPhase('reconnect-wait');
    const delay = Math.min(
      this.backoffMaxMs,
      this.backoffMinMs * this.backoffFactor ** this.attempts,
    );
    this.attempts += 1;
    this.schedule(() => void this.runDiscovery(), delay);
  }

  private handleBrokerRestart(): void {
    // Every watermark is invalid (ws-protocol.md §8); stores rebuild fresh.
    this.watermarks.clear();
    this.firstConnectOfBoot = true;
    this.rejectAllPending(new Error('broker restarted'));
    for (const conduit of this.conduits.values()) conduit.handleBrokerRestart();
    this.emit('onBrokerRestart');
  }

  private closeSocket(): void {
    const socket = this.ws;
    this.ws = undefined;
    if (socket !== undefined) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      this.timers.clear(entry.timeout);
      entry.reject(err);
    }
    this.pending.clear();
  }

  // -- replay -----------------------------------------------------------------

  private sendReplayRequests(): void {
    // Channels we hold watermarks for: resume exactly after the last
    // processed seq (original seq values are replayed — dedupe is downstream).
    for (const [channel, last] of this.watermarks) {
      this.sendOn(channel, { kind: 'replay-request', channel, fromSeq: last + 1 });
    }
    if (this.firstConnectOfBoot) {
      for (const channel of this.replayFromZero) {
        if (!this.watermarks.has(channel)) {
          this.sendOn(channel, { kind: 'replay-request', channel, fromSeq: 0 });
        }
      }
      this.firstConnectOfBoot = false;
    }
    // PTY conduits replay on their own byte axis.
    for (const conduit of this.conduits.values()) conduit.handleReconnected();
  }

  // -- outbound ---------------------------------------------------------------

  /** Send a payload on `channel`. False when not connected (caller decides). */
  private sendOn(channel: ChannelName, payload: unknown): boolean {
    const socket = this.ws;
    if (socket === undefined || socket.readyState !== WS_OPEN) {
      this.logger.debug('send skipped — not connected', { channel });
      return false;
    }
    socket.send(encodeEnvelope(channel, this.outSeq.next(channel), payload));
    return true;
  }

  private sendBinary(frame: Uint8Array): boolean {
    const socket = this.ws;
    if (socket === undefined || socket.readyState !== WS_OPEN) return false;
    socket.send(frame);
    return true;
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `req_fe_${this.requestCounter}`;
  }

  /**
   * Issue a control request; resolves with the result, rejects with
   * {@link ControlRequestError} on ok:false or an Error on transport failure.
   */
  request(request: ControlRequestDraft, timeoutMs?: number): Promise<ControlResult> {
    if (this.phase !== 'connected') {
      return Promise.reject(new Error(`gateway not connected (phase: ${this.phase})`));
    }
    const id = request.id ?? this.nextRequestId();
    // Key order mirrors the golden corpus payload builders: {kind, id, params}.
    const wire = (request.params === undefined
      ? { kind: request.kind, id }
      : { kind: request.kind, id, params: request.params }) as ControlRequest;
    return new Promise<ControlResult>((resolve, reject) => {
      const timeout = this.timers.set(() => {
        this.pending.delete(id);
        reject(new Error('control request timed out'));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      if (!this.sendOn(CHANNEL.CONTROL, wire)) {
        this.pending.delete(id);
        this.timers.clear(timeout);
        reject(new Error('gateway not connected'));
      }
    });
  }

  /** Approval decisions ride the approvals channel (ws-protocol.md §10.2). */
  sendApprovalDecision(decision: ApprovalDecision): boolean {
    return this.sendOn(CHANNEL.APPROVALS, decision);
  }

  /**
   * Merge requests ride the workstream channel (ws-protocol.md §16.2 — THE
   * one lineage verb the FE sends; the sendApprovalDecision mirror). Returns
   * false when not connected: the caller renders the unsendable instrument
   * state (FE-6 ports.ts WorkstreamMergeSender) — nothing throws.
   */
  sendWorkstreamMergeRequest(request: WorkstreamMergeRequest): boolean {
    return this.sendOn(CHANNEL.WORKSTREAM, request);
  }

  /**
   * The six frozen pipeline verbs (`pipeline-validate` / `-save` / `-launch` /
   * `-pause` / `-resume` / `-cancel`) ride the pipelines channel
   * (ws-protocol.md §18.2 — the §16.2 merge-request precedent: a feature-scoped
   * verb rides its own fan-out channel, not `control`). ONE method carries all
   * six; the union is discriminated on `kind`. The mirror of
   * `sendApprovalDecision` / `sendWorkstreamMergeRequest`: returns false when
   * not connected — the FE-6 deck renders the unsendable instrument state
   * (features/pipelines/ports.ts PipelineVerbSender; register.tsx detects this
   * method structurally). Nothing throws, nothing toasts (NO SIGNAL doctrine).
   */
  sendPipelineMessage(message: PipelineClientPayload): boolean {
    return this.sendOn(CHANNEL.PIPELINES, message);
  }

  /** Open (or fetch) the PTY byte conduit for a session. */
  openPty(sessionId: string): PtyConduit {
    const existing = this.conduits.get(sessionId);
    if (existing !== undefined) return existing;
    const channel = ptyChannel(sessionId);
    const conduit = new PtyConduit(
      sessionId,
      {
        sendJson: (payload) => this.sendOn(channel, payload),
        sendBinary: (frame) => this.sendBinary(frame),
      },
      this.logger,
    );
    this.conduits.set(sessionId, conduit);
    // ws-protocol.md §6 attach pin: OUTPUT frames flow to a connection only
    // after its FIRST pty-replay-request on this channel — there is no
    // implicit attach at subscribe time. A conduit opened while already
    // connected must therefore attach NOW (fromWatermark = consumed watermark,
    // 0 for a fresh conduit); conduits opened before/between connections are
    // attached by sendReplayRequests() when the socket (re)opens.
    if (this.phase === 'connected') conduit.handleReconnected();
    return conduit;
  }

  closePty(sessionId: string): void {
    this.conduits.get(sessionId)?.close();
    this.conduits.delete(sessionId);
  }

  // -- inbound ----------------------------------------------------------------

  private handleFrame(data: string | Uint8Array): void {
    const verdict = routeBrokerFrame(data);
    if (!verdict.ok) {
      // Malformed frame: dropped + logged, the connection is unaffected
      // (plan §9.2 FE-2 negative row).
      this.logger.warn('protocol violation — frame dropped', {
        code: verdict.code,
        stage: verdict.stage,
      });
      this.emit('onViolation', { code: verdict.code, stage: verdict.stage });
      return;
    }
    const message = verdict.message;

    // Reconnect-replay dedupe on the per-(boot, channel) seq axis: replayed
    // envelopes keep their ORIGINAL seq, so anything ≤ the watermark has
    // already been processed — dropping it here is what guarantees "no
    // duplicate rows" (plan §9.2 FE-2 edge row).
    const replayChannel = replayableChannelOf(message);
    if (replayChannel !== undefined) {
      const seq = seqOf(message) as number;
      const prev = this.watermarks.get(replayChannel);
      if (prev !== undefined && seq <= prev) {
        this.emit('onDuplicateDropped', replayChannel, seq);
        return;
      }
      this.watermarks.set(replayChannel, seq);
    }

    switch (message.kind) {
      case 'control-response': {
        const entry = this.pending.get(message.response.id);
        if (entry !== undefined) {
          this.pending.delete(message.response.id);
          this.timers.clear(entry.timeout);
          if (message.response.ok) entry.resolve(message.response.result);
          else entry.reject(new ControlRequestError(message.response.error));
        }
        break;
      }
      case 'pushed-error': {
        if (message.error.code === 'bad-auth') {
          // Fail VISIBLY: no reconnect storm on a bad token; the server
          // closes 1008 right after this push (ws-protocol.md §1).
          this.logger.error('gateway rejected auth token — halting reconnect');
          this.setPhase('auth-rejected');
        } else {
          this.logger.warn('gateway pushed error', {
            code: message.error.code,
            channel: message.error.channel ?? null,
          });
        }
        break;
      }
      case 'pty-frame': {
        this.conduits.get(message.frame.sessionId)?.handleFrame(message.frame);
        return; // byte path: never sprayed at reactive listeners
      }
      default:
        break;
    }
    this.emit('onMessage', message);
  }
}
