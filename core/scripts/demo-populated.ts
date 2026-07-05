/**
 * demo-populated — the DEV-ONLY "populated demo broker" (design-review edition).
 *
 * Boots the FULL real broker (composeBroker: real gateway + kernel + workstream
 * + pipeline slices + publisher sink) and floods EVERY frozen channel with
 * REPRESENTATIVE fixture data so the real cockpit frontend renders FULLY
 * POPULATED for a rendered design review — with NO real Claude sessions, NO
 * quota spend, NO LM Studio, NO Bedrock, NO real account data.
 *
 * The ONE substitution the synthetic edition allows is the same one demo-m1
 * uses: the QueryRunner is `@aibender/testkit`'s FakeQueryRunner instead of the
 * live SDK spawn path. Everything else is the REAL frozen-protocol broker code:
 * every payload rides the real gateway publish methods, which VALIDATE against
 * the FROZEN validators and JOURNAL for reconnect-replay — so a freshly
 * connecting cockpit gets the whole populated set replayed from watermark 0.
 *
 * Unlike demo-m1 (a TAP-style pass/fail probe that tears down), this script
 * STAYS ALIVE: after publishing, it keeps the gateway listening and the frames
 * journaled until you Ctrl-C. Point the browser cockpit at the logged url+token
 * (see DELIVERABLE 2 in the handoff / this file's tail) and every panel paints.
 *
 * What lands on the wire (blueprint §6.3 dashboards + the lineage/run views):
 *   - quota          MAX_A/B/C/D/ENT 5h + 7d snapshots (realistic usedPct/reset)
 *   - events         read-model-snapshots for ALL §6.3 dashboards + a few
 *                    event-summaries (quota-gauges, burn-rate, bedrock-cost
 *                    [estimate-only], api-equivalent-usd, cache-hit-rate,
 *                    latency, health, skill-leaderboard, session-outcomes,
 *                    local-offload, resource-health) — all fresh where honest
 *   - context-graph  ~30 context-touch frames forming a small non-trivial graph
 *                    (CLAUDE.md, memory files, agent artifacts, a few sessions)
 *   - workstream     nodes + edges forming a branch/continue/merge lineage tree
 *                    + a list snapshot + a merge-resolved + a branch advisory
 *   - pipelines      a pipeline-run-snapshot with steps MAX_A → AWS_DEV → LOCAL
 *                    incl. an awaiting-approval step + a catalog snapshot
 *   - transcript     one launched (fake) session emitting assistant/tool/result
 *   - approvals      one pending approval-request in the inbox
 *
 * Honest NO-SIGNAL: AWS_DEV/LOCAL BACKENDS stay disconnected (LM Studio/Bedrock
 * are not running) — but their PANELS render, driven by the read models above
 * (bedrock-cost is estimate-only, local-offload reports lmstudio-down). That is
 * truthful, not a gap.
 *
 * [X2]: every value is synthesized — placeholder labels (MAX_A..MAX_D / ENT /
 * AWS_DEV / LOCAL), ses_/synthetic paths, obviously-fake numbers. No real account dir is
 * read; no real process is spawned; LM Studio/opencode/bedrock are never
 * started. The bootstrap file DOES land in the REAL $HOME/.aibender (so the FE
 * discovery path finds it) but carries only placeholder labels + a per-boot
 * loopback token.
 *
 * Run:  tsx core/scripts/demo-populated.ts     (from the repo root)
 * Stop: Ctrl-C (SIGINT) — closes cleanly and retracts the bootstrap file.
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL,
  streamForChannel,
  validateControlResponse,
  type ContextGraphTouch,
  type Envelope,
  type PipelineServerPayload,
  type QuotaSnapshot,
  type WorkstreamServerPayload,
} from '@aibender/protocol';
import { createLogger } from '@aibender/shared';
import { FakePtyBackend, FakeQueryRunner } from '@aibender/testkit';
import { WebSocket as WsClient } from 'ws';

import type { AccountRegistry, DiscoveredAccount } from '../src/kernel/index.js';
import { composeBroker, type BrokerPublishSinks } from '../src/main/index.js';

// NOTE ON THE PORT: the frozen gateway binds `listen(0)` — an OS-assigned
// loopback port (ws-protocol.md §1; core/src/gateway/server.ts). There is no
// committed option to pin a fixed port, and pinning one would mean editing
// prod source, which this dev-only harness deliberately does not do. It does
// not need to: broker discovery is designed AROUND the random port — the
// bootstrap file (and the dev `__AIBENDER_BOOTSTRAP__` global) carry the
// actual port + per-boot token, and both the FE and this script read them at
// runtime. The port is logged prominently on startup.

// A stable synthetic "now" the fixtures anchor to (kept in the recent past so
// resetsAt / freshness lastIngestAt read as fresh against real wall-clock).
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function say(line: string): void {
  console.log(line);
}

// ---------------------------------------------------------------------------
// Fixture data — synthesized [X2], shapes adapted from the frozen golden WS
// corpus (packages/testkit/src/wsGolden.ts) so every frame passes the FROZEN
// validators the gateway publish methods enforce.
// ---------------------------------------------------------------------------

const CLAUDE_ACCOUNTS = ['MAX_A', 'MAX_B', 'MAX_C', 'MAX_D', 'ENT'] as const;

/** (a) CHANNEL.QUOTA — a 5h + 7d snapshot per Claude account. */
function quotaSnapshots(): readonly QuotaSnapshot[] {
  // Deliberately varied so the gauges look alive: some near-limit, some idle.
  const fivePct: Record<(typeof CLAUDE_ACCOUNTS)[number], number> = {
    MAX_A: 41.5,
    MAX_B: 88,
    MAX_C: 12,
    MAX_D: 97.2,
    ENT: 63,
  };
  const sevenPct: Record<(typeof CLAUDE_ACCOUNTS)[number], number> = {
    MAX_A: 30,
    MAX_B: 100,
    MAX_C: 8.4,
    MAX_D: 71,
    ENT: 55.5,
  };
  const out: QuotaSnapshot[] = [];
  for (const account of CLAUDE_ACCOUNTS) {
    out.push({
      kind: 'quota-snapshot',
      account,
      window: '5h',
      usedPct: fivePct[account],
      resetsAt: NOW + 3 * HOUR,
      capturedAt: NOW - MIN,
      source: 'statusline',
    });
    out.push({
      kind: 'quota-snapshot',
      account,
      window: '7d',
      usedPct: sevenPct[account],
      // MAX_B is maxed with a reset already due (FE renders "reset due").
      resetsAt: account === 'MAX_B' ? NOW - HOUR : NOW + 4 * DAY,
      capturedAt: NOW - MIN,
      source: 'oauth-poll',
    });
  }
  return out;
}

/**
 * (b) CHANNEL.EVENTS — read-model-snapshots for ALL §6.3 dashboards plus a few
 * event-summaries. Every `sources[].state` is a first-class freshness state;
 * `fresh` with a recent lastIngestAt keeps panels out of NO SIGNAL, while
 * bedrock-cost (estimate-only) and local-offload (lmstudio-down) render the
 * HONEST degraded state for the backends that genuinely are not running.
 */
function eventFrames(): readonly Record<string, unknown>[] {
  const fresh = (source: string) => ({ source, state: 'fresh', lastIngestAt: NOW - 30_000 });
  return [
    // A couple of raw event-summaries so the raw feed is non-empty.
    {
      kind: 'event-summary',
      eventId: 1,
      ts: NOW - 2 * MIN,
      account: 'MAX_A',
      backend: 'claude_code',
      source: 'claude-jsonl',
      eventType: 'assistant-turn',
      sessionId: 'ses_demo_hist_1',
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheCreationTokens: 120 },
      costEstimatedUsd: 0.021,
      latencyMs: 1800,
      ttftMs: 140,
      ok: true,
    },
    {
      kind: 'event-summary',
      eventId: 2,
      ts: NOW - 90_000,
      account: 'ENT',
      backend: 'claude_code',
      source: 'claude-otel',
      eventType: 'tool-result',
      toolName: 'Bash',
      skillName: 'write-report',
      ok: true,
    },
    // 1 — quota gauges
    {
      kind: 'read-model-snapshot',
      readModel: 'quota-gauges',
      capturedAt: NOW,
      sources: [fresh('claude-quota')],
      data: {
        gauges: [
          { account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: NOW + 3 * HOUR },
          { account: 'MAX_A', window: '7d', usedPct: 30, resetsAt: NOW + 4 * DAY },
          { account: 'MAX_B', window: '5h', usedPct: 88, resetsAt: NOW + 3 * HOUR },
          { account: 'MAX_B', window: '7d', usedPct: 100, resetsAt: NOW - HOUR },
          { account: 'MAX_C', window: '5h', usedPct: 12, resetsAt: NOW + 3 * HOUR },
          { account: 'MAX_D', window: '5h', usedPct: 97.2, resetsAt: NOW + 3 * HOUR },
          { account: 'ENT', window: '5h', usedPct: 63, resetsAt: NOW + 3 * HOUR },
        ],
      },
    },
    // 2 — burn rate + projected exhaustion
    {
      kind: 'read-model-snapshot',
      readModel: 'burn-rate',
      capturedAt: NOW,
      sources: [fresh('claude-jsonl')],
      data: {
        entries: [
          {
            account: 'MAX_B',
            blockStartAt: NOW - 2 * HOUR,
            blockEndAt: NOW + 3 * HOUR,
            tokensPerHour: 420000,
            usedPct: 88,
            projectedExhaustionAt: NOW + 40 * MIN,
          },
          {
            account: 'MAX_A',
            blockStartAt: NOW - HOUR,
            blockEndAt: NOW + 4 * HOUR,
            tokensPerHour: 120000,
            usedPct: 30,
            projectedExhaustionAt: NOW + 6 * HOUR,
          },
        ],
      },
    },
    // 3 — bedrock actual-vs-estimate (estimate-only is honest: SSO gated)
    {
      kind: 'read-model-snapshot',
      readModel: 'bedrock-cost',
      capturedAt: NOW,
      sources: [
        { source: 'bedrock-cost-explorer', state: 'estimate-only' },
        { source: 'bedrock-cloudwatch', state: 'sso-expired', lastIngestAt: NOW - 2 * DAY },
      ],
      data: { estimateMtdUsd: 128.4 },
    },
    // 4 — api-equivalent usd
    {
      kind: 'read-model-snapshot',
      readModel: 'api-equivalent-usd',
      capturedAt: NOW,
      sources: [fresh('claude-jsonl')],
      data: {
        basis: 'api-equivalent',
        entries: [
          { account: 'MAX_A', backend: 'claude_code', equivalentUsd: 214.5 },
          { account: 'MAX_B', backend: 'claude_code', equivalentUsd: 402 },
          { account: 'ENT', backend: 'claude_code', equivalentUsd: 96.2 },
        ],
        windowDays: 7,
      },
    },
    // 5 — cache hit w/ TTL split
    {
      kind: 'read-model-snapshot',
      readModel: 'cache-hit-rate',
      capturedAt: NOW,
      sources: [fresh('claude-jsonl')],
      data: {
        entries: [
          { account: 'MAX_A', hitRatePct: 87.5, readTokens: 720000, creation5mTokens: 40000, creation1hTokens: 60000 },
          { account: 'ENT', hitRatePct: 74.1, readTokens: 210000, creation5mTokens: 18000, creation1hTokens: 22000 },
        ],
      },
    },
    // 6 — latency p50/p95/TTFT
    {
      kind: 'read-model-snapshot',
      readModel: 'latency',
      capturedAt: NOW,
      sources: [fresh('claude-otel')],
      data: {
        entries: [
          { backend: 'claude_code', p50Ms: 640, p95Ms: 2100, ttftP50Ms: 120, ttftP95Ms: 380, sampleCount: 220 },
          { backend: 'lmstudio', p50Ms: 300, p95Ms: 900, ttftP50Ms: 80, ttftP95Ms: 200, sampleCount: 40 },
        ],
      },
    },
    // 7 — err/throttle health
    {
      kind: 'read-model-snapshot',
      readModel: 'health',
      capturedAt: NOW,
      sources: [fresh('claude-jsonl'), { source: 'opencode-sse', state: 'stale', lastIngestAt: NOW - 8 * MIN }],
      data: {
        entries: [
          { source: 'claude-jsonl', errorCount: 0, retryCount: 3, throttleCount: 1, timeoutCount: 0, windowMinutes: 60 },
          { source: 'opencode-sse', errorCount: 2, retryCount: 4, throttleCount: 0, timeoutCount: 1, windowMinutes: 60 },
        ],
      },
    },
    // 8 — skill leaderboard
    {
      kind: 'read-model-snapshot',
      readModel: 'skill-leaderboard',
      capturedAt: NOW,
      sources: [fresh('claude-otel')],
      data: {
        entries: [
          { skillName: 'write-report', invocations: 42, successRatePct: 90.5, tokensPerOutcome: 5400.5, worstQuartile: false },
          { skillName: 'refactor-pass', invocations: 18, successRatePct: 61, tokensPerOutcome: 12100, worstQuartile: true, correctionRatePct: 22 },
          { skillName: 'summarize-thread', invocations: 30, successRatePct: 96, tokensPerOutcome: 1800, worstQuartile: false },
        ],
      },
    },
    // 9 — session outcomes
    {
      kind: 'read-model-snapshot',
      readModel: 'session-outcomes',
      capturedAt: NOW,
      sources: [fresh('claude-jsonl')],
      data: {
        entries: [
          { outcome: 'completed', count: 37 },
          { outcome: 'aborted', count: 4 },
          { outcome: 'error', count: 2 },
        ],
        windowDays: 7,
      },
    },
    // 10 — local-offload (lmstudio-down is honest: LM Studio isn't running)
    {
      kind: 'read-model-snapshot',
      readModel: 'local-offload',
      capturedAt: NOW,
      sources: [{ source: 'lmstudio', state: 'lmstudio-down' }],
      data: { offloadRatioPct: 22.2, localTokens: 200000, totalTokens: 900000, windowDays: 7 },
    },
    // 11 — resource health (the supervision instrument, §11)
    {
      kind: 'read-model-snapshot',
      readModel: 'resource-health',
      capturedAt: NOW,
      sources: [{ source: 'lmstudio', state: 'lmstudio-down' }],
      data: {
        pressureLevel: 2,
        pressureState: 'amber',
        freeRamPct: 28.5,
        swapUsedBytes: 5_368_709_120,
        residentSessionCount: 3,
        localModelResidentBytes: 0,
        sessions: [
          { account: 'MAX_A', backend: 'claude_code', slot: 0, footprintMb: 2100, band: 'ok' },
          { account: 'MAX_B', backend: 'claude_code', slot: 0, footprintMb: 3200, band: 'warn' },
          { account: 'AWS_DEV', backend: 'opencode', slot: 0, footprintMb: 1600, band: 'recycle', hibernated: false },
        ],
        notices: [{ action: 'hibernate-non-account', at: NOW - 3 * MIN, account: 'AWS_DEV', backend: 'opencode' }],
      },
    },
  ];
}

/**
 * (c) CHANNEL.CONTEXT_GRAPH — ~30 touches across a few sessions forming a
 * small but non-trivial graph: shared instruction files (CLAUDE.md, memory),
 * per-session reads/writes, and watched agent artifacts.
 */
function contextTouches(): readonly ContextGraphTouch[] {
  const sessions = ['ses_demo_a', 'ses_demo_b', 'ses_demo_c'];
  const shared = [
    { path: '/synthetic/workspace/CLAUDE.md', relation: 'instructions' as const },
    { path: '/synthetic/workspace/.claude/rules.md', relation: 'instructions' as const },
    { path: '/synthetic/memory/MEMORY.md', relation: 'read' as const },
    { path: '/synthetic/memory/the-program.md', relation: 'read' as const },
  ];
  const perSession: Record<string, Array<{ path: string; relation: ContextGraphTouch['relation'] }>> = {
    ses_demo_a: [
      { path: '/synthetic/workspace/core/src/main/index.ts', relation: 'read' },
      { path: '/synthetic/workspace/core/src/gateway/server.ts', relation: 'read' },
      { path: '/synthetic/workspace/core/src/main/composedBroker.spec.ts', relation: 'write' },
      { path: '/synthetic/workspace/.claude/agents/reviewer.md', relation: 'watched' },
    ],
    ses_demo_b: [
      { path: '/synthetic/workspace/packages/protocol/src/workstream.ts', relation: 'read' },
      { path: '/synthetic/workspace/packages/protocol/src/pipeline.ts', relation: 'read' },
      { path: '/synthetic/workspace/packages/protocol/src/validate.ts', relation: 'write' },
      { path: '/synthetic/workspace/.claude/agents/planner.md', relation: 'watched' },
    ],
    ses_demo_c: [
      { path: '/synthetic/workspace/app/src/main.tsx', relation: 'read' },
      { path: '/synthetic/workspace/app/src/lib/ws/wsClient.ts', relation: 'read' },
      { path: '/synthetic/workspace/app/src/chrome/Chrome.tsx', relation: 'write' },
      { path: '/synthetic/artifacts/design-review.md', relation: 'watched' },
    ],
  };
  const out: ContextGraphTouch[] = [];
  let t = NOW - 20 * MIN;
  for (const sessionId of sessions) {
    // Each session touches the shared instruction/memory nodes (fan-in edges).
    for (const s of shared) {
      out.push({ kind: 'context-touch', sessionId, path: s.path, relation: s.relation, ts: (t += 5_000) });
    }
    for (const p of perSession[sessionId] ?? []) {
      out.push({ kind: 'context-touch', sessionId, path: p.path, relation: p.relation, ts: (t += 5_000) });
    }
  }
  return out;
}

/**
 * (d) CHANNEL.WORKSTREAM — a branch/continue/merge lineage tree. Two parent
 * branches continue a couple of steps, then merge into one child node; plus a
 * list snapshot for the rail, a resolved-merge marker, and a branch advisory.
 * Shapes mirror the golden workstream fixtures (validated + journaled by
 * gateway.publishWorkstream).
 */
function workstreamFrames(): readonly WorkstreamServerPayload[] {
  const node = (
    sessionId: string,
    account: string,
    state: string,
    over: Partial<Record<string, unknown>> = {},
  ): WorkstreamServerPayload =>
    ({
      kind: 'workstream-node',
      sessionId,
      workstreamId: 'ws_demo',
      backend: 'claude_code',
      account,
      state,
      origin: 'harness',
      confidence: 'recorded',
      cwd: '/synthetic/workspace',
      createdAt: NOW - 15 * MIN,
      lastActiveAt: NOW - MIN,
      ...over,
    }) as unknown as WorkstreamServerPayload;

  const edge = (
    edgeId: string,
    fromSessionId: string,
    toSessionId: string,
    edgeType: string,
    over: Partial<Record<string, unknown>> = {},
  ): WorkstreamServerPayload =>
    ({
      kind: 'workstream-edge',
      edgeId,
      fromSessionId,
      toSessionId,
      edgeType,
      confidence: 'recorded',
      ts: NOW - 10 * MIN,
      ...over,
    }) as unknown as WorkstreamServerPayload;

  const listSnapshot: WorkstreamServerPayload = {
    kind: 'workstream-list-snapshot',
    capturedAt: NOW,
    workstreams: [
      { workstreamId: 'ws_demo', title: 'design-review cockpit', status: 'active', tags: ['demo', 'review'], nodeCount: 6, updatedAt: NOW - MIN },
    ],
    detachedNodeCount: 1,
  } as unknown as WorkstreamServerPayload;

  return [
    listSnapshot,
    // Root, then a fork into two branches. `state` is the LINEAGE node enum
    // (running|idle|completed|abandoned|unresumable|external), NOT the
    // resume-ledger process state — the two axes are deliberately distinct.
    node('ses_ws_root', 'MAX_A', 'completed', { displayName: 'root: scope the review' }),
    node('ses_ws_branch1', 'MAX_A', 'completed', { displayName: 'branch: backend audit' }),
    node('ses_ws_branch2', 'MAX_B', 'completed', { displayName: 'branch: frontend audit' }),
    node('ses_ws_cont1', 'MAX_A', 'completed', { displayName: 'continue: backend deep-dive' }),
    node('ses_ws_merge', 'MAX_A', 'running', { displayName: 'merge: unified findings' }),
    edge('edg_fork_1', 'ses_ws_root', 'ses_ws_branch1', 'fork'),
    edge('edg_fork_2', 'ses_ws_root', 'ses_ws_branch2', 'fork'),
    edge('edg_cont_1', 'ses_ws_branch1', 'ses_ws_cont1', 'continue'),
    edge('edg_merge_1', 'ses_ws_cont1', 'ses_ws_merge', 'merge_parent'),
    edge('edg_merge_2', 'ses_ws_branch2', 'ses_ws_merge', 'merge_parent'),
    // A synthesis brief for the merge (handoff/merge briefs are mandatory).
    {
      kind: 'workstream-brief',
      briefId: 'br_demo_merge',
      briefKind: 'merge',
      body: 'merge brief: backend + frontend audits fused; conflicts surfaced explicitly.',
      sourceSessionIds: ['ses_ws_cont1', 'ses_ws_branch2'],
      provenance: 'refined',
      createdAt: NOW - 5 * MIN,
      workstreamId: 'ws_demo',
    } as unknown as WorkstreamServerPayload,
    {
      kind: 'workstream-merge-resolved',
      mergeId: 'mrg_demo_1',
      sessionId: 'ses_ws_merge',
      briefId: 'br_demo_merge',
    } as unknown as WorkstreamServerPayload,
    // A context-pressure branch advisory on the running merge session.
    {
      kind: 'branch-advisory',
      sessionId: 'ses_ws_merge',
      contextUsedPct: 71.5,
      ts: NOW - 30_000,
    } as unknown as WorkstreamServerPayload,
  ];
}

/**
 * (e) CHANNEL.PIPELINES — a catalog snapshot + a run snapshot whose steps span
 * MAX_A → AWS_DEV → LOCAL with an approval gate awaiting-approval in the
 * middle, so the run monitor populates and shows a gated run.
 */
function pipelineFrames(): readonly PipelineServerPayload[] {
  const catalog: PipelineServerPayload = {
    kind: 'catalog-snapshot',
    capturedAt: NOW,
    workspace: '/synthetic/workspace',
    entries: [
      {
        capId: 'cap_demo_1',
        kind: 'skill',
        name: 'write-report',
        scope: 'project',
        backendFamily: 'claude',
        workspace: '/synthetic/workspace',
        sourcePath: '/synthetic/workspace/.claude/skills/write-report/SKILL.md',
        contentHash: 'sha256:deadbeefcafe',
        slash: '/write-report',
      },
      {
        capId: 'cap_demo_2',
        kind: 'skill',
        name: 'cross-account-review',
        scope: 'project',
        backendFamily: 'claude',
        workspace: '/synthetic/workspace',
        sourcePath: '/synthetic/workspace/.claude/skills/cross-account-review/SKILL.md',
        contentHash: 'sha256:beadfeedface',
        slash: '/cross-account-review',
      },
    ],
  } as unknown as PipelineServerPayload;

  const runSnapshot: PipelineServerPayload = {
    kind: 'pipeline-run-snapshot',
    capturedAt: NOW,
    run: {
      // The RUN is `paused` on the approval gate (run states are pending|
      // running|paused|completed|failed|cancelled — `awaiting-approval` is a
      // STEP state only); the gated step below carries `awaiting-approval`.
      runId: 'run_demo_1',
      pipelineId: 'wf_demo',
      state: 'paused',
      resumable: true,
      schemaHash: 'sha256:deadbeefcafe',
      costEstimatedUsd: 0.6,
    },
    steps: [
      { runId: 'run_demo_1', stepId: 'research', iteration: 0, attempt: 0, state: 'completed', sessionId: 'ses_pl_1', account: 'MAX_A', costEstimatedUsd: 0.2 },
      { runId: 'run_demo_1', stepId: 'sign-off', iteration: 0, attempt: 0, state: 'awaiting-approval', account: 'MAX_A' },
      { runId: 'run_demo_1', stepId: 'implement', iteration: 0, attempt: 0, state: 'pending', account: 'AWS_DEV' },
      { runId: 'run_demo_1', stepId: 'summarize', iteration: 0, attempt: 0, state: 'pending', account: 'LOCAL' },
    ],
  } as unknown as PipelineServerPayload;

  return [
    catalog,
    runSnapshot,
    // A rollup run-status so the run header reads a cost estimate.
    {
      kind: 'pipeline-run-status',
      runId: 'run_demo_1',
      pipelineId: 'wf_demo',
      state: 'paused',
      costEstimatedUsd: 0.6,
    } as unknown as PipelineServerPayload,
  ];
}

// ---------------------------------------------------------------------------
// A minimal frozen-protocol WS client (mirrors composedBroker.spec's
// WireClient) — used ONLY to launch the live demo session over the control
// channel + escalate one approval, exactly as a cockpit client would.
// ---------------------------------------------------------------------------

class WireClient {
  private seq = 0;

  private constructor(private readonly ws: WsClient) {
    ws.on('error', () => {
      /* teardown races are expected */
    });
  }

  static async connect(url: string, token: string): Promise<WireClient> {
    const ws = new WsClient(`${url}/?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new WireClient(ws);
  }

  /** Await a control `result` for a given request id (validates the response). */
  async launch(id: string, params: Record<string, unknown>): Promise<string> {
    const done = new Promise<string>((resolve, reject) => {
      const onMessage = (data: unknown): void => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(String(data)) as Envelope;
        } catch {
          return;
        }
        if (envelope.channel !== 'control') return;
        const parsed = validateControlResponse(envelope.payload);
        if (!parsed.ok || parsed.value.id !== id) return;
        this.ws.off('message', onMessage);
        if (!parsed.value.ok) {
          reject(new Error(`launch failed: ${parsed.value.error.code}`));
          return;
        }
        const result = parsed.value.result;
        if (result.verb !== 'launch') {
          reject(new Error('expected a launch result'));
          return;
        }
        resolve(result.sessionId);
      };
      this.ws.on('message', onMessage);
      setTimeout(() => {
        this.ws.off('message', onMessage);
        reject(new Error('timed out awaiting launch result'));
      }, 5000).unref();
    });
    const envelope: Envelope = {
      stream: streamForChannel(CHANNEL.CONTROL),
      channel: CHANNEL.CONTROL,
      seq: this.seq++,
      payload: { kind: 'launch', id, params },
    };
    this.ws.send(JSON.stringify(envelope));
    return done;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * A synthetic AccountRegistry advertising the five Claude accounts. Injected in
 * place of the real infra/profiles discovery so the cockpit enumerates
 * MAX_A/B/C/D/ENT WITHOUT reading any real account manifest or dir [X2]. The
 * config dirs are computed placeholder paths under the aibender home; nothing
 * ever reads or writes them (the QueryRunner is fake — no real spawn).
 */
function fakeAccountRegistry(aibenderHome: string): AccountRegistry {
  const dirName: Record<string, string> = {
    MAX_A: 'max-a',
    MAX_B: 'max-b',
    MAX_C: 'max-c',
    MAX_D: 'max-d',
    ENT: 'ent',
  };
  const accounts: DiscoveredAccount[] = CLAUDE_ACCOUNTS.map((label) => {
    const configDir = join(aibenderHome, 'accounts', dirName[label] ?? label.toLowerCase());
    return {
      // The FORM (MAX_<X>/ENT) is a sanctioned Claude-account label — cast the
      // string literal onto the branded registry label type.
      label: label as DiscoveredAccount['label'],
      backend: 'claude_code' as const,
      configDir,
      securestorageDir: configDir,
      source: `<synthetic:${label}>`,
    };
  });
  const byLabel = new Map(accounts.map((a) => [a.label as string, a]));
  const labels = accounts.map((a) => a.label);
  return {
    labels: () => labels,
    has: (label: string) => byLabel.has(label),
    get: (label: string) => byLabel.get(label),
    all: () => accounts,
  };
}

// ---------------------------------------------------------------------------
// The demo daemon
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const aibenderHome = join(homedir(), '.aibender');
  await mkdir(aibenderHome, { recursive: true, mode: 0o700 });

  // The ONE fake in the SDK chain (demo-m1's substitution). Manual mode: the
  // launched demo session stays open so FLEET shows a live session + we can
  // escalate an approval before completing it.
  const runner = new FakeQueryRunner({ mode: 'manual', providePids: true });
  const backend = new FakePtyBackend();

  // Capture the frozen-typed publisher sinks (the events lane VALIDATES the
  // events union — the honest path for read-model snapshots).
  let sinks: BrokerPublishSinks | undefined;

  const logger = createLogger({ sink: (record) => say(`[gateway] ${JSON.stringify(record)}`) });

  const broker = await composeBroker({
    // A temp in-memory store — no on-disk kernel db is needed for a demo.
    storePath: ':memory:',
    // The REAL machine-local dir so the bootstrap file lands where the FE looks.
    // The injected synthetic account registry advertises MAX_A/B/C/D/ENT so the
    // bootstrap `claudeAccounts` carrier (ICR-0014) drives the cockpit's account
    // enumeration WITHOUT reading any real infra/profiles manifest [X2].
    profiles: { aibenderHome, accountRegistry: fakeAccountRegistry(aibenderHome) },
    runner,
    baseEnv: { PATH: '/usr/bin' },
    logger,
    gateway: {
      aibenderHome,
      writeBootstrap: true,
      logger,
    },
    pty: { backend, logger },
    // A gate may wait forever — no expiry so the pending approval stays pending.
    approvals: { defaultTtlMs: null },
    // Compose the lineage + pipeline slices so the workstream/pipelines channels
    // are live (and their boot snapshots journal). The publisher lane captures
    // the validating event sink.
    workstreams: { logger },
    publishers: [
      (published) => {
        sinks = published;
      },
    ],
  });

  if (sinks === undefined) throw new Error('publisher sink was not captured');

  try {
    // -- (a) QUOTA -----------------------------------------------------------
    const quotas = quotaSnapshots();
    for (const snapshot of quotas) broker.gateway.publishQuota(snapshot);

    // -- (b) EVENTS (read-model-snapshots + summaries), validated ------------
    const events = eventFrames();
    for (const payload of events) {
      // The lane's publishEvent validates against the FROZEN events union.
      sinks.publishEvent(payload as never);
    }

    // -- (c) CONTEXT_GRAPH ---------------------------------------------------
    const touches = contextTouches();
    for (const touch of touches) broker.gateway.publishContextTouch(touch);

    // -- (d) WORKSTREAM ------------------------------------------------------
    const wsFrames = workstreamFrames();
    for (const payload of wsFrames) broker.gateway.publishWorkstream(payload);

    // -- (e) PIPELINES -------------------------------------------------------
    const plFrames = pipelineFrames();
    for (const payload of plFrames) broker.gateway.publishPipeline(payload);

    // -- (f) a launched (fake) session → FLEET + TRANSCRIPT + WORK zone ------
    // Launch over the wire exactly like a cockpit client (control channel),
    // then drive the FakeQueryRunner in manual mode to emit a few messages.
    const client = await WireClient.connect(broker.gateway.url, broker.gateway.token);
    const sessionId = await client.launch('req_demo_launch', {
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'populated demo session',
      prompt: 'synthesized demo prompt',
    });

    const fake = runner.session(sessionId);
    // An assistant text delta.
    fake.emit({
      type: 'other',
      raw: {
        type: 'assistant',
        uuid: 'uuid_demo_1',
        message: { content: [{ type: 'text', text: 'Reviewing the cockpit layout across all channels…' }] },
      },
    });
    // A tool start + result pair.
    fake.emit({
      type: 'other',
      raw: {
        type: 'assistant',
        uuid: 'uuid_demo_2',
        message: { content: [{ type: 'tool_use', id: 'tu_demo_1', name: 'Read', input: { file_path: '/synthetic/workspace/DESIGN.md' } }] },
      },
    });
    fake.emit({
      type: 'other',
      raw: {
        type: 'user',
        uuid: 'uuid_demo_3',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_demo_1', content: 'ok' }] },
      },
    });

    // -- (g) APPROVALS: one pending approval-request in the inbox ------------
    // The (fake) SDK escalates a tool exactly like a real child would; the
    // request rides the approvals channel and stays pending (no expiry).
    const started = runner.starts[0];
    if (started?.canUseTool !== undefined) {
      // Fire-and-forget: we deliberately never resolve it, so the inbox keeps
      // one pending entry for the design review.
      void started.canUseTool('Bash', { command: 'ls -la /synthetic/workspace' }, { toolUseId: 'tu_demo_approval' });
    }

    // Keep this internal client open (its transcript subscription is not
    // required — the FE opens its own). We hold it so the launched session
    // stays live in FLEET; we do NOT complete it.
    void client;

    // -- report --------------------------------------------------------------
    const g = broker.gateway;
    say('');
    say('  ============================================================');
    say('   POPULATED DEMO BROKER — LIVE (Ctrl-C to stop)');
    say('  ============================================================');
    say(`   gateway url    : ${g.url}`);
    say(`   port           : ${g.port}`);
    say(`   token          : ${g.token}`);
    say(`   connect url    : ${g.url}/?token=${g.token}`);
    say(`   bootstrap file : ${g.bootstrapPath}`);
    say('  ------------------------------------------------------------');
    say(`   published: quota=${quotas.length}  events=${events.length}  ` +
      `context-touches=${touches.length}  workstream=${wsFrames.length}  pipelines=${plFrames.length}`);
    say(`   launched session: ${sessionId} (FLEET + transcript)`);
    say(`   pending approvals: 1`);
    say(`   claude accounts advertised: ${CLAUDE_ACCOUNTS.join(', ')} (+ FE seeds AWS_DEV, LOCAL)`);
    say('  ------------------------------------------------------------');
    say('   POINT THE BROWSER COCKPIT AT THIS BROKER (dev, no Tauri):');
    say('   1. pnpm -F aibender-app dev   # vite dev server on :5173');
    say('   2. In the page, set the dev discovery global the FE reads, then');
    say('      trigger a reconnect WITHOUT reloading (a reload wipes a global');
    say('      set from the console/eval — nativeBootstrapProvider would then');
    say('      find nothing and boot disconnected):');
    say('        window.__AIBENDER_BOOTSTRAP__ = {');
    say(`          port: ${g.port}, token: ${JSON.stringify(g.token)},`);
    say(`          pid: ${process.pid}, startedAt: ${JSON.stringify(new Date().toISOString())},`);
    say(`          claudeAccounts: ${JSON.stringify([...CLAUDE_ACCOUNTS])}`);
    say('        };');
    say('      then click the RECONNECT buttons (or run the ⌘K "reconnect');
    say('      gateway" verb) — each re-invokes nativeBootstrapProvider against');
    say('      the now-present global. Do NOT call location.reload().');
    say('   (nativeBootstrapProvider reads __AIBENDER_BOOTSTRAP__ outside Tauri.)');
    say('  ============================================================');
    say('');

    // -- STAY ALIVE ----------------------------------------------------------
    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      say(`\n# received ${signal} — closing broker + retracting bootstrap file…`);
      client.close();
      await broker.close().catch(() => undefined);
      say('# closed. bye.');
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // Park forever (an unref'd interval keeps the loop honest without pinning
    // the CPU) — the gateway's own listening socket keeps the process alive.
    setInterval(() => {}, 1 << 30).unref();
  } catch (cause) {
    await broker.close().catch(() => undefined);
    throw cause;
  }
}

run().catch((cause) => {
  say(`# DEMO ERROR — ${(cause as Error).stack ?? String(cause)}`);
  process.exitCode = 1;
});
