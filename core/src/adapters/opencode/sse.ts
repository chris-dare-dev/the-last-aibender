/**
 * OpenCode SSE transport (BE-4; blueprint §4.2; probe findings
 * docs/research/findings/opencode-serve-event-probe.md).
 *
 * Subscribes `/global/event` as the live source of truth and exposes ONE
 * consumable async stream for BE-5 (M3). Contract, per the probe:
 *
 *   - DEDUPE strictly on the monotonic `evt_` id (`payload.id`). Bounded
 *     LRU-ish window; reconnect replays therefore surface no duplicates.
 *   - `type:"sync"` wrappers are DROPPED after recording their
 *     `syncEvent.seq` per `syncEvent.aggregateID` (the watermark capture)
 *     and fanning the evt_↔seq correlation out to {@link
 *     OpencodeSseTransport.onSync} observers (BE-5's collector marks durable
 *     slots covered at parse time — the M3 stewarding ICR). Sync wrappers
 *     never enter the dedupe set — the plain twin must pass regardless of
 *     arrival order.
 *   - UNKNOWN event types pass through untouched (the 10 s
 *     `server.heartbeat` is not even in the OpenAPI spec — hard evidence the
 *     parser must tolerate unknowns). Malformed `data:` JSON is skipped and
 *     counted, never thrown.
 *   - `directory` is OPTIONAL on the envelope even though the schema marks
 *     it required (stream-synthesized events omit it).
 *   - RECONNECT with capped exponential backoff; gap repair belongs to
 *     {@link OpencodeSseTransport.replaySession} — the per-session durable
 *     stream `GET /api/session/{id}/event?after=<seq>` (the replay
 *     primitive), driven by the captured watermarks.
 *
 * The envelope adapter is deliberately THIN so the transport can flip to the
 * v2 `/api/event` surface later without changing consumers (probe rec. 10).
 */

// ---------------------------------------------------------------------------
// SSE wire parsing (minimal, spec-conformant subset)
// ---------------------------------------------------------------------------

export interface SseMessage {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

/**
 * Parse a text/event-stream body into messages. Handles multi-line `data:`,
 * `event:`/`id:` fields, comment lines (`: heartbeat`), and CRLF.
 */
export async function* parseSseStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventField: string | undefined;
  let idField: string | undefined;

  const flush = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      eventField = undefined;
      idField = undefined;
      return undefined;
    }
    const message: SseMessage = {
      data: dataLines.join('\n'),
      ...(eventField !== undefined ? { event: eventField } : {}),
      ...(idField !== undefined ? { id: idField } : {}),
    };
    dataLines = [];
    eventField = undefined;
    idField = undefined;
    return message;
  };

  const handleLine = (rawLine: string): SseMessage | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined; // comment (v2 heartbeat style)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventField = value;
    else if (field === 'id') idField = value;
    return undefined; // unknown fields ignored per SSE spec
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = handleLine(line);
      if (message !== undefined) yield message;
    }
  }
  // Trailing line without newline, then final dispatch.
  if (buffer.length > 0) {
    const message = handleLine(buffer);
    if (message !== undefined) yield message;
  }
  const last = flush();
  if (last !== undefined) yield last;
}

// ---------------------------------------------------------------------------
// Transport event shape (thin envelope — v2-flip friendly)
// ---------------------------------------------------------------------------

/** One deduped live event off `/global/event`. */
export interface OpencodeEvent {
  /** The monotonic `evt_` id (dedupe key). Empty string when absent. */
  readonly id: string;
  readonly type: string;
  readonly properties: unknown;
  readonly directory?: string;
  readonly project?: string;
}

/** One message off the per-session durable replay stream. */
export interface OpencodeDurableEvent {
  /** SSE `id:` field when present. */
  readonly sseId?: string;
  /** SSE `event:` field when present. */
  readonly sseEvent?: string;
  /** Parsed JSON payload (SessionDurableEvent shape — kept opaque here). */
  readonly payload: unknown;
  /** Durable seq when the payload carries one (watermark math). */
  readonly seq?: number;
}

export interface SseTransportStats {
  /** Connections successfully opened (reconnects increment). */
  readonly connects: number;
  /** Events dropped by evt_-id dedupe. */
  readonly deduped: number;
  /** sync wrappers absorbed into watermarks. */
  readonly syncWrappersDropped: number;
  /** data: payloads that failed JSON parsing (skipped, tolerated). */
  readonly malformedDropped: number;
}

/**
 * One sync-wrapper observation: the durable slot (`aggregateId`, `seq`) and,
 * when the wrapper carries it (probe: `syncEvent.id` is the plain twin's
 * `evt_` id), the correlated live-event id. Exposed per the BE-5 M3 return's
 * ICR so the collector can mark durable slots covered as soon as the sync
 * twin is parsed — closing the one-chunk at-least-once window between the
 * `evt_` and `oc-durable:` raw_ref namespaces (see
 * core/src/collector/opencode/sseSource.ts).
 */
export interface OpencodeSyncCorrelation {
  readonly aggregateId: string;
  readonly seq: number;
  /** The plain twin's `evt_` id when the wrapper names it. */
  readonly eventId?: string;
}

export type SseTransportState = 'idle' | 'connecting' | 'connected' | 'closed';

export interface OpencodeSseTransport {
  /**
   * THE consumable stream (single consumer — BE-5's collector). Calling
   * events() connects EAGERLY (a background pump feeds the iterable); the
   * stream survives disconnects via internal reconnect and ends only after
   * {@link close} (or when the consumer abandons iteration).
   */
  events(): AsyncIterable<OpencodeEvent>;
  /** Highest durable seq seen for an aggregate (session) via sync wrappers. */
  watermark(aggregateId: string): number | undefined;
  watermarks(): ReadonlyMap<string, number>;
  /**
   * Observe every parsed sync wrapper AT PARSE TIME (before the next event is
   * pumped): the durable slot plus the correlated `evt_` id when carried.
   * Fires for every valid wrapper (including seq re-deliveries — the consumer
   * owns its own max/dedupe policy). Listener errors are swallowed: an
   * observer must never kill the pump. Returns an unsubscribe.
   */
  onSync(listener: (correlation: OpencodeSyncCorrelation) => void): () => void;
  /**
   * Gap repair: replay a session's durable events after a seq watermark
   * (`GET /api/session/{id}/event?after=<seq>`). The underlying stream stays
   * live — the CONSUMER terminates iteration once caught up (break), which
   * aborts the request.
   */
  replaySession(sessionId: string, afterSeq: number): AsyncIterable<OpencodeDurableEvent>;
  state(): SseTransportState;
  stats(): SseTransportStats;
  close(): void;
}

export interface OpencodeSseTransportOptions {
  /** Serve base URL, e.g. `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** HTTP Basic header value (from the serve handle's `authHeader()`). */
  readonly authHeader: string;
  readonly fetchFn?: typeof fetch;
  /** Backoff: initial delay ms (default 250), doubling to max (default 10s). */
  readonly reconnectInitialMs?: number;
  readonly reconnectMaxMs?: number;
  /** Injectable sleep (tests run backoff instantly). */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** Dedupe window size (default 4096 most-recent evt_ ids). */
  readonly dedupeWindow?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface GlobalEnvelope {
  readonly directory?: string;
  readonly project?: string;
  readonly payload?: unknown;
}

export function createOpencodeSseTransport(
  options: OpencodeSseTransportOptions,
): OpencodeSseTransport {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const initialMs = options.reconnectInitialMs ?? 250;
  const maxMs = options.reconnectMaxMs ?? 10_000;
  const dedupeWindow = options.dedupeWindow ?? 4096;

  const seenIds = new Set<string>();
  const watermarks = new Map<string, number>();
  const syncListeners = new Set<(correlation: OpencodeSyncCorrelation) => void>();
  let state: SseTransportState = 'idle';
  let closed = false;
  let consuming = false;
  let abortCurrent: AbortController | undefined;
  const stats = { connects: 0, deduped: 0, syncWrappersDropped: 0, malformedDropped: 0 };

  const rememberId = (id: string): boolean => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > dedupeWindow) {
      // Set iterates in insertion order — evict the oldest.
      const oldest = seenIds.values().next().value;
      if (oldest !== undefined) seenIds.delete(oldest);
    }
    return true;
  };

  const captureWatermark = (syncEvent: unknown, wrapperId: string | undefined): void => {
    if (typeof syncEvent !== 'object' || syncEvent === null) return;
    const record = syncEvent as Record<string, unknown>;
    const aggregate = record['aggregateID'];
    const seq = record['seq'];
    if (typeof aggregate !== 'string' || typeof seq !== 'number') return;
    const previous = watermarks.get(aggregate);
    if (previous === undefined || seq > previous) watermarks.set(aggregate, seq);
    // Correlation fan-out (BE-5 ICR): syncEvent.id IS the plain twin's evt_
    // id (probe §2 double delivery); the wrapper's own id mirrors it.
    const eventId =
      typeof record['id'] === 'string' && record['id'].length > 0
        ? record['id']
        : wrapperId !== undefined && wrapperId.length > 0
          ? wrapperId
          : undefined;
    const correlation: OpencodeSyncCorrelation = {
      aggregateId: aggregate,
      seq,
      ...(eventId !== undefined ? { eventId } : {}),
    };
    for (const listener of syncListeners) {
      try {
        listener(correlation);
      } catch {
        // Observers never kill the pump.
      }
    }
  };

  /** Map one /global/event data payload to an emitted event (or undefined). */
  const toEvent = (data: string): OpencodeEvent | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      stats.malformedDropped += 1;
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      stats.malformedDropped += 1;
      return undefined;
    }
    const envelope = parsed as GlobalEnvelope;
    const payload = envelope.payload;
    if (typeof payload !== 'object' || payload === null) {
      stats.malformedDropped += 1;
      return undefined;
    }
    const record = payload as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string') {
      stats.malformedDropped += 1;
      return undefined;
    }
    if (type === 'sync') {
      // Durable-store mirror: capture the watermark (+ fan the evt_↔seq
      // correlation out to onSync observers), drop the wrapper. NEVER
      // registers the evt_ id — the plain twin must still pass.
      captureWatermark(
        record['syncEvent'],
        typeof record['id'] === 'string' ? record['id'] : undefined,
      );
      stats.syncWrappersDropped += 1;
      return undefined;
    }
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    if (id !== '' && !rememberId(id)) {
      stats.deduped += 1;
      return undefined;
    }
    return {
      id,
      type,
      properties: record['properties'],
      ...(typeof envelope.directory === 'string' ? { directory: envelope.directory } : {}),
      ...(typeof envelope.project === 'string' ? { project: envelope.project } : {}),
    };
  };

  /**
   * The live pump: connects EAGERLY when events() is called (not on first
   * next()), pushes deduped events into a queue the returned iterable
   * drains. Reconnect loop lives in the pump; close() ends the queue.
   */
  function startEventStream(): AsyncIterable<OpencodeEvent> {
    if (consuming) {
      throw new Error('OpencodeSseTransport: events() supports a single consumer');
    }
    consuming = true;

    const queue: OpencodeEvent[] = [];
    let ended = false;
    let stopped = false; // consumer abandoned the iterable without close()
    let notify: (() => void) | undefined;
    const wake = (): void => {
      notify?.();
      notify = undefined;
    };
    const push = (event: OpencodeEvent): void => {
      queue.push(event);
      wake();
    };
    const end = (): void => {
      ended = true;
      wake();
    };

    void (async () => {
      let delayMs = initialMs;
      try {
        while (!closed && !stopped) {
          state = 'connecting';
          const abort = new AbortController();
          abortCurrent = abort;
          try {
            const response = await fetchFn(`${options.baseUrl}/global/event`, {
              headers: { authorization: options.authHeader, accept: 'text/event-stream' },
              signal: abort.signal,
            });
            if (!response.ok || response.body === null) {
              throw new Error(`global/event answered ${String(response.status)}`);
            }
            state = 'connected';
            stats.connects += 1;
            delayMs = initialMs; // successful connect resets backoff
            for await (const message of parseSseStream(response.body)) {
              if (closed || stopped) return;
              const event = toEvent(message.data);
              if (event !== undefined) push(event);
            }
            // Server closed the stream — fall through to reconnect.
          } catch {
            if (closed || stopped) return;
          } finally {
            abortCurrent = undefined;
          }
          if (closed || stopped) return;
          await sleepFn(delayMs);
          delayMs = Math.min(delayMs * 2, maxMs);
        }
      } finally {
        state = closed ? 'closed' : 'idle';
        end();
      }
    })();

    return {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<OpencodeEvent> {
        try {
          for (;;) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            if (ended || closed) return;
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        } finally {
          // Consumer left (break/return/close): stop the pump so an
          // abandoned iterable never keeps a connection or grows the queue.
          stopped = true;
          consuming = false;
          abortCurrent?.abort();
        }
      },
    };
  }

  async function* replay(
    sessionId: string,
    afterSeq: number,
  ): AsyncGenerator<OpencodeDurableEvent> {
    const abort = new AbortController();
    try {
      const url =
        `${options.baseUrl}/api/session/${encodeURIComponent(sessionId)}/event` +
        `?after=${encodeURIComponent(String(afterSeq))}`;
      const response = await fetchFn(url, {
        headers: { authorization: options.authHeader, accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`session durable stream answered ${String(response.status)}`);
      }
      for await (const message of parseSseStream(response.body)) {
        let payload: unknown;
        try {
          payload = JSON.parse(message.data);
        } catch {
          stats.malformedDropped += 1;
          continue;
        }
        let seq: number | undefined;
        if (typeof payload === 'object' && payload !== null) {
          const record = payload as Record<string, unknown>;
          if (typeof record['seq'] === 'number') seq = record['seq'];
          else if (typeof record['durable'] === 'object' && record['durable'] !== null) {
            const durable = record['durable'] as Record<string, unknown>;
            if (typeof durable['seq'] === 'number') seq = durable['seq'];
          }
        }
        yield {
          payload,
          ...(message.id !== undefined ? { sseId: message.id } : {}),
          ...(message.event !== undefined ? { sseEvent: message.event } : {}),
          ...(seq !== undefined ? { seq } : {}),
        };
      }
    } finally {
      abort.abort(); // consumer broke out — release the connection
    }
  }

  return {
    events: () => startEventStream(),
    watermark: (aggregateId) => watermarks.get(aggregateId),
    watermarks: () => watermarks,
    onSync: (listener) => {
      syncListeners.add(listener);
      return () => {
        syncListeners.delete(listener);
      };
    },
    replaySession: (sessionId, afterSeq) => ({
      [Symbol.asyncIterator]: () => replay(sessionId, afterSeq),
    }),
    state: () => state,
    stats: () => ({ ...stats }),
    close: () => {
      closed = true;
      state = 'closed';
      abortCurrent?.abort();
    },
  };
}
