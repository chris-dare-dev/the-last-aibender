/**
 * §9.3 BE↔FE #5 — reconnect: kill the WS mid-stream → the FE resumes from
 * watermarks with NO duplicated or lost rows; the context-graph converges to
 * identical state after replay.
 *
 * The gateway journals every broadcast on a replayable channel with a
 * per-(boot, channel) seq (core/src/gateway/journal.ts, ws-protocol.md §8);
 * the FE client tracks the highest seq it processed per channel and, on
 * reconnect, sends ONE `replay-request` naming `fromSeq` = the first seq it
 * has NOT processed. The broker re-sends `seq >= fromSeq` with ORIGINAL seqs.
 *
 * This suite ASSEMBLES that end-to-end against the REAL gateway: it publishes
 * over the wire, hard-terminates the socket, publishes more, reconnects, and
 * replays from the watermark. It asserts the union of pre-kill + replayed
 * seqs is exactly the contiguous set with no gap and no duplicate (exactly-
 * once), and that a context-graph rebuilt from the replayed touches converges
 * to the same node/edge set a never-disconnected observer would hold.
 *
 * [X2]: synthesized touch paths + session ids only; no identity crosses.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { CHANNEL, type ContextGraphTouch, type Envelope } from '@aibender/protocol';

import { startGateway, type GatewayHandle } from '../../../../core/src/gateway/server.ts';
import { createGraphFeed } from '../../../../core/src/collector/graphfeed/index.ts';

import { WireClient, waitFor } from '../support/wireClient.ts';

let handle: GatewayHandle;
let home: string;
const clients: WireClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await handle?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

async function harness(): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'aibender-integ-reconnect-'));
  handle = await startGateway({
    kernel: {
      launch: () => Promise.reject(new Error('not used')),
      resume: () => Promise.reject(new Error('not used')),
      status: () => [],
      kill: () => Promise.reject(new Error('not used')),
    } as unknown as Parameters<typeof startGateway>[0]['kernel'],
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

/** Collect (seq, path) tuples for context-graph frames a client receives. */
interface GraphObserver {
  readonly touches: Array<{ seq: number; touch: ContextGraphTouch }>;
  readonly maxSeqProcessed: () => number;
}

function graphObserver(): GraphObserver & { onEnvelope: (e: Envelope) => void } {
  const touches: Array<{ seq: number; touch: ContextGraphTouch }> = [];
  return {
    touches,
    maxSeqProcessed: () => touches.reduce((m, t) => Math.max(m, t.seq), -1),
    onEnvelope: (envelope) => {
      if (envelope.channel !== CHANNEL.CONTEXT_GRAPH) return;
      const payload = envelope.payload as { kind?: string } & Partial<ContextGraphTouch>;
      if (payload.kind === 'context-touch' || payload.sessionId !== undefined) {
        touches.push({ seq: envelope.seq, touch: payload as ContextGraphTouch });
      }
    },
  };
}

/** Reduce a stream of touches into a converged {nodes, edges} state. */
function convergeGraph(touches: readonly ContextGraphTouch[]): {
  nodes: Set<string>;
  edges: Set<string>;
} {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const touch of touches) {
    nodes.add(`file:${touch.path}`);
    nodes.add(`session:${touch.sessionId}`);
    edges.add(`${touch.sessionId}--${touch.relation}-->${touch.path}`);
  }
  return { nodes, edges };
}

describe('BE↔FE #5 — reconnect: watermark replay, exactly-once, graph converges', () => {
  it('events channel: kill mid-stream → replay from watermark → no gap, no duplicate', async () => {
    await harness();

    // First client processes some events, then dies mid-stream.
    const seenBefore: number[] = [];
    const first = await WireClient.connect(handle.url, handle.token, {
      onEnvelope: (e) => {
        if (e.channel === CHANNEL.EVENTS) seenBefore.push(e.seq);
      },
    });
    clients.push(first);

    // Publish a first batch onto the events channel via the gateway sink.
    for (let i = 0; i < 5; i += 1) {
      handle.publishEvent({ kind: 'event-summary', text: `synthetic event ${String(i)}` });
    }
    await waitFor(() => seenBefore.length >= 5);
    const lastProcessed = Math.max(...seenBefore);

    // Hard-kill the socket mid-stream, then publish MORE while disconnected.
    first.terminate();
    for (let i = 5; i < 9; i += 1) {
      handle.publishEvent({ kind: 'event-summary', text: `synthetic event ${String(i)}` });
    }

    // Reconnect a fresh client and replay from the first UNprocessed seq.
    const replayed: number[] = [];
    const second = await WireClient.connect(handle.url, handle.token, {
      onEnvelope: (e) => {
        if (e.channel === CHANNEL.EVENTS) replayed.push(e.seq);
      },
    });
    clients.push(second);
    second.send(CHANNEL.EVENTS, {
      kind: 'replay-request',
      channel: 'events',
      fromSeq: lastProcessed + 1,
    });

    await waitFor(() => replayed.length >= 4);

    // Exactly-once: pre-kill seqs ∪ replayed seqs = the contiguous [0..8],
    // with NO overlap (no duplicate) and NO gap (no loss).
    const before = new Set(seenBefore);
    const after = new Set(replayed);
    const overlap = [...after].filter((s) => before.has(s));
    expect(overlap, 'replay must not re-deliver already-processed seqs').toEqual([]);
    const union = new Set([...before, ...after]);
    expect([...union].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('context-graph converges to identical state after a mid-stream reconnect+replay', async () => {
    await harness();

    const feed = createGraphFeed({ sink: handle, clock: () => Date.UTC(2026, 6, 4) });

    // A never-disconnected observer is the convergence oracle.
    const oracle = graphObserver();
    const oracleClient = await WireClient.connect(handle.url, handle.token, {
      onEnvelope: oracle.onEnvelope,
    });
    clients.push(oracleClient);

    // A second observer that will die mid-stream and resume from watermark.
    const flaky = graphObserver();
    let flakyClient = await WireClient.connect(handle.url, handle.token, {
      onEnvelope: flaky.onEnvelope,
    });
    clients.push(flakyClient);

    const touches = [
      { sessionId: 'ses_g1', path: '/synthetic/a.ts', relation: 'read' as const },
      { sessionId: 'ses_g1', path: '/synthetic/b.ts', relation: 'write' as const },
      { sessionId: 'ses_g2', path: '/synthetic/a.ts', relation: 'read' as const },
    ];
    // First two land while both are connected.
    expect(feed.ingestWatcherTouch(touches[0]!)).toBe(true);
    expect(feed.ingestWatcherTouch(touches[1]!)).toBe(true);
    await waitFor(() => flaky.touches.length >= 2 && oracle.touches.length >= 2);

    const flakyWatermark = flaky.maxSeqProcessed() + 1;
    flakyClient.terminate();

    // The third lands while the flaky observer is DISCONNECTED.
    expect(feed.ingestWatcherTouch(touches[2]!)).toBe(true);
    await waitFor(() => oracle.touches.length >= 3);

    // Reconnect + replay from the watermark.
    flakyClient = await WireClient.connect(handle.url, handle.token, {
      onEnvelope: flaky.onEnvelope,
    });
    clients.push(flakyClient);
    flakyClient.send(CHANNEL.CONTEXT_GRAPH, {
      kind: 'replay-request',
      channel: 'context-graph',
      fromSeq: flakyWatermark,
    });
    await waitFor(() => flaky.touches.length >= 3);

    // Both graphs converge to identical node/edge sets — no lost touch, and
    // de-duped-by-seq means no double-counted touch.
    const bySeq = new Map<number, ContextGraphTouch>();
    for (const t of flaky.touches) bySeq.set(t.seq, t.touch); // dedupe on seq
    const flakyGraph = convergeGraph([...bySeq.values()]);
    const oracleGraph = convergeGraph(oracle.touches.map((t) => t.touch));

    expect(flakyGraph.nodes).toEqual(oracleGraph.nodes);
    expect(flakyGraph.edges).toEqual(oracleGraph.edges);
    // And the converged graph is the full expected set (3 files? no — 2 files,
    // 2 sessions; a.ts touched by two sessions is ONE node).
    expect(oracleGraph.nodes).toEqual(
      new Set([
        'file:/synthetic/a.ts',
        'file:/synthetic/b.ts',
        'session:ses_g1',
        'session:ses_g2',
      ]),
    );
    expect(oracleGraph.edges.size).toBe(3);
  });
});
