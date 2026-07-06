/**
 * OS-2 correctness proof for the SQL aggregation accessors: for a large seeded-
 * random corpus, every accessor must equal a JS reference computed over the
 * FROZEN `events.list()` (`ORDER BY ts_ms, id`) — the exact algorithm the BE-6
 * projections used before OS-2. This is the byte-identical guarantee that lets
 * the SQL layer replace the JS group-by loops without moving a dashboard number.
 *
 * The corpus deliberately inserts rows OUT of ts order (so id and ts_ms diverge)
 * to exercise the first-appearance ordering — the reason the grouped queries use
 * `ROW_NUMBER() OVER (ORDER BY ts_ms, id)` + `MIN(rn)` rather than the SQLite
 * default group order. [X2]: synthesized labels/models/paths only.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { openEventsStore, type EventsStore, type EventRow, type NewEventRow } from './index.js';

// A tiny deterministic LCG so a failure is always reproducible.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// Valid (account, backend, source) triples (the insert path enforces the
// label↔backend pairing; source is free but we keep it plausible).
const TRIPLES = [
  { account: 'MAX_A', backend: 'claude_code', source: 'claude-jsonl' },
  { account: 'MAX_B', backend: 'claude_code', source: 'claude-otel' },
  { account: 'ENT', backend: 'claude_code', source: 'claude-jsonl' },
  { account: 'AWS_DEV', backend: 'opencode', source: 'opencode-sse' },
  { account: 'LOCAL', backend: 'lmstudio', source: 'lmstudio' },
] as const;

const SKILLS = ['write-report', 'refactor-pass', 'summarize', undefined];
const ERROR_KINDS = ['error', 'retry', 'throttle', 'timeout', undefined] as const;
const MODELS = ['synth-a', 'synth-b', undefined];

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 86_400_000;

function buildCorpus(rng: () => number, n: number): NewEventRow[] {
  const rows: NewEventRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const triple = TRIPLES[Math.floor(rng() * TRIPLES.length)] ?? TRIPLES[0];
    // Spread ts across ~30 days; NOT monotonic with insert order (the point).
    const tsMs = NOW - Math.floor(rng() * 30 * DAY);
    const ok = rng() < 0.4 ? true : rng() < 0.7 ? false : undefined;
    const errorKind = ERROR_KINDS[Math.floor(rng() * ERROR_KINDS.length)];
    const skillName = SKILLS[Math.floor(rng() * SKILLS.length)];
    const model = MODELS[Math.floor(rng() * MODELS.length)];
    const row: NewEventRow = {
      tsMs,
      backend: triple.backend,
      account: triple.account,
      source: triple.source,
      eventType: 'api_request',
      rawRef: `synth:${String(i)}`,
      ...(rng() < 0.8 ? { inputTokens: Math.floor(rng() * 5000) } : {}),
      ...(rng() < 0.8 ? { outputTokens: Math.floor(rng() * 2000) } : {}),
      ...(rng() < 0.6 ? { cacheReadTokens: Math.floor(rng() * 9000) } : {}),
      ...(rng() < 0.6 ? { cacheCreationTokens: Math.floor(rng() * 3000) } : {}),
      ...(rng() < 0.5 ? { cacheCreation5mTokens: Math.floor(rng() * 1000) } : {}),
      ...(rng() < 0.5 ? { cacheCreation1hTokens: Math.floor(rng() * 1000) } : {}),
      ...(rng() < 0.5 ? { latencyMs: Math.floor(rng() * 4000) } : {}),
      ...(rng() < 0.4 ? { ttftMs: Math.floor(rng() * 500) } : {}),
      ...(rng() < 0.5 ? { costEstimatedUsd: Math.round(rng() * 1000) / 100 } : {}),
      ...(rng() < 0.2 && triple.backend === 'opencode'
        ? { costActualUsd: Math.round(rng() * 1000) / 100 }
        : {}),
      ...(model !== undefined ? { model, provider: 'synth-provider' } : {}),
      ...(skillName !== undefined ? { skillName } : {}),
      ...(ok !== undefined ? { ok } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
    };
    rows.push(row);
  }
  return rows;
}

// ---- JS reference algorithms (the pre-OS-2 projection math over list()) ----

const tok = (r: EventRow): number =>
  (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);

function refCacheByAccount(rows: readonly EventRow[]): Array<Record<string, unknown>> {
  const map = new Map<string, { input: number; read: number; c5m: number; c1h: number }>();
  for (const r of rows) {
    const g = map.get(r.account) ?? { input: 0, read: 0, c5m: 0, c1h: 0 };
    g.input += r.inputTokens ?? 0;
    g.read += r.cacheReadTokens ?? 0;
    g.c5m += r.cacheCreation5mTokens ?? 0;
    g.c1h += r.cacheCreation1hTokens ?? 0;
    map.set(r.account, g);
  }
  return [...map.entries()].map(([account, g]) => ({
    account,
    inputTokens: g.input,
    readTokens: g.read,
    creation5mTokens: g.c5m,
    creation1hTokens: g.c1h,
  }));
}

function refHealthBySource(rows: readonly EventRow[]): Array<Record<string, unknown>> {
  const map = new Map<string, { e: number; r: number; th: number; ti: number }>();
  for (const row of rows) {
    const g = map.get(row.source) ?? { e: 0, r: 0, th: 0, ti: 0 };
    switch (row.errorKind) {
      case 'error':
        g.e += 1;
        break;
      case 'retry':
        g.r += 1;
        break;
      case 'throttle':
        g.th += 1;
        break;
      case 'timeout':
        g.ti += 1;
        break;
      default:
        if (row.ok === false) g.e += 1;
    }
    map.set(row.source, g);
  }
  return [...map.entries()].map(([source, g]) => ({
    source,
    errorCount: g.e,
    retryCount: g.r,
    throttleCount: g.th,
    timeoutCount: g.ti,
  }));
}

function refSkill(rows: readonly EventRow[]): Array<Record<string, unknown>> {
  const map = new Map<string, { inv: number; ok: number; out: number; tokens: number }>();
  for (const r of rows) {
    if (r.skillName === undefined) continue;
    const g = map.get(r.skillName) ?? { inv: 0, ok: 0, out: 0, tokens: 0 };
    g.inv += 1;
    if (r.ok !== undefined) g.out += 1;
    if (r.ok === true) g.ok += 1;
    g.tokens += tok(r);
    map.set(r.skillName, g);
  }
  return [...map.entries()].map(([skillName, g]) => ({
    skillName,
    invocations: g.inv,
    okCount: g.ok,
    outcomeCount: g.out,
    totalTokens: g.tokens,
  }));
}

describe('EventsAggregatesStore — equivalence with the JS-over-list reference (OS-2)', () => {
  let store: EventsStore;

  beforeAll(async () => {
    store = await openEventsStore({ path: ':memory:' });
    const rng = makeRng(0xa1b2c3d4);
    for (const row of buildCorpus(rng, 400)) store.events.insert(row);
    // A handful of session_outcomes with out-of-order capture times.
    const outcomes = ['completed', 'aborted', 'error', 'completed', 'completed'];
    const orng = makeRng(0x5e6f);
    for (let i = 0; i < 40; i += 1) {
      store.sessionOutcomes.insert({
        account: 'MAX_A',
        nativeSessionId: `synth-native-${String(i)}`,
        outcome: outcomes[Math.floor(orng() * outcomes.length)] ?? 'completed',
        capturedAtMs: NOW - Math.floor(orng() * 20 * DAY),
        rawRef: `outcome:${String(i)}`,
      });
    }
  });

  afterAll(() => store.close());

  const since = 0; // whole corpus

  it('cacheTokensByAccount matches the reference (values AND first-appearance order)', () => {
    const rows = store.events.list({ sinceTsMs: since });
    expect(store.eventsAggregates.cacheTokensByAccount(since)).toEqual(refCacheByAccount(rows));
  });

  it('healthCountsBySource matches the reference (CASE rule + order)', () => {
    const rows = store.events.list({ sinceTsMs: since });
    expect(store.eventsAggregates.healthCountsBySource(since)).toEqual(refHealthBySource(rows));
  });

  it('skillAggregates matches the reference (counts, token sums, order)', () => {
    const rows = store.events.list({ sinceTsMs: since });
    expect(store.eventsAggregates.skillAggregates(since)).toEqual(refSkill(rows));
  });

  it('tokenSumsByBackend matches the reference (order-independent)', () => {
    const rows = store.events.list({ sinceTsMs: since });
    const ref = new Map<string, number>();
    for (const r of rows) ref.set(r.backend, (ref.get(r.backend) ?? 0) + tok(r));
    const got = new Map(store.eventsAggregates.tokenSumsByBackend(since).map((b) => [b.backend, b.tokens]));
    expect(got).toEqual(ref);
  });

  it('burnRows is the narrow (account, ts, tokens) projection of list() in the same order', () => {
    const rows = store.events.list({ sinceTsMs: since });
    expect(store.eventsAggregates.burnRows(since)).toEqual(
      rows.map((r) => ({ account: r.account, tsMs: r.tsMs, tokens: tok(r) })),
    );
  });

  it('estimateRows carries exactly the cost columns of list() in the same order', () => {
    const rows = store.events.list({ sinceTsMs: since });
    const narrow = (r: EventRow): Record<string, unknown> => ({
      account: r.account,
      ...(r.provider !== undefined ? { provider: r.provider } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
      ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
      ...(r.cacheReadTokens !== undefined ? { cacheReadTokens: r.cacheReadTokens } : {}),
      ...(r.cacheCreationTokens !== undefined ? { cacheCreationTokens: r.cacheCreationTokens } : {}),
      ...(r.costEstimatedUsd !== undefined ? { costEstimatedUsd: r.costEstimatedUsd } : {}),
    });
    expect(store.eventsAggregates.estimateRows(since)).toEqual(rows.map(narrow));
  });

  it('costRows(opencode) filters + carries the actual column, same order', () => {
    const rows = store.events.list({ backend: 'opencode', sinceTsMs: since });
    const narrow = (r: EventRow): Record<string, unknown> => ({
      tsMs: r.tsMs,
      ...(r.provider !== undefined ? { provider: r.provider } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
      ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
      ...(r.cacheReadTokens !== undefined ? { cacheReadTokens: r.cacheReadTokens } : {}),
      ...(r.cacheCreationTokens !== undefined ? { cacheCreationTokens: r.cacheCreationTokens } : {}),
      ...(r.costEstimatedUsd !== undefined ? { costEstimatedUsd: r.costEstimatedUsd } : {}),
      ...(r.costActualUsd !== undefined ? { costActualUsd: r.costActualUsd } : {}),
    });
    expect(store.eventsAggregates.costRows(since, 'opencode')).toEqual(rows.map(narrow));
  });

  it('latencySamples carries (backend, latency, ttft) of list() in the same order', () => {
    const rows = store.events.list({ sinceTsMs: since });
    expect(store.eventsAggregates.latencySamples(since)).toEqual(
      rows.map((r) => ({
        backend: r.backend,
        ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
        ...(r.ttftMs !== undefined ? { ttftMs: r.ttftMs } : {}),
      })),
    );
  });

  it('outcomeCounts matches the reference (first-appearance order by captured_at_ms, id)', () => {
    const rows = store.sessionOutcomes.list();
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.outcome, (map.get(r.outcome) ?? 0) + 1);
    expect(store.eventsAggregates.outcomeCounts(0)).toEqual(
      [...map.entries()].map(([outcome, count]) => ({ outcome, count })),
    );
  });

  it('respects the sinceTsMs window boundary identically to list()', () => {
    const since2 = NOW - 5 * DAY;
    const rows = store.events.list({ sinceTsMs: since2 });
    expect(store.eventsAggregates.cacheTokensByAccount(since2)).toEqual(refCacheByAccount(rows));
    expect(store.eventsAggregates.healthCountsBySource(since2)).toEqual(refHealthBySource(rows));
  });

  it('empty window yields empty aggregates (never fabricated rows)', () => {
    const future = NOW + 999 * DAY;
    expect(store.eventsAggregates.cacheTokensByAccount(future)).toEqual([]);
    expect(store.eventsAggregates.healthCountsBySource(future)).toEqual([]);
    expect(store.eventsAggregates.tokenSumsByBackend(future)).toEqual([]);
    expect(store.eventsAggregates.skillAggregates(future)).toEqual([]);
    expect(store.eventsAggregates.burnRows(future)).toEqual([]);
    expect(store.eventsAggregates.latencySamples(future)).toEqual([]);
  });
});

// The regression the OS-2 adversarial review's hunter found: token COLUMNS are
// each a safe integer at insert (< 2^53), but a per-row 4-class sum, or a
// per-group sum, can EXCEED 2^53. A SQL-side sum would make node:sqlite (default
// non-BigInt) throw ERR_OUT_OF_RANGE where the old JS float-fold returned a
// finite (lossy) number. The token folds therefore stay in JS. This locks that:
// no throw, and byte-identical to the JS-over-list() reference at the boundary.
describe('EventsAggregatesStore — token sums across the 2^53 boundary never throw (OS-2 hunter regression)', () => {
  let store: EventsStore;
  const BIG = 5_000_000_000_000_000; // safe integer per column; two of them sum past 2^53

  beforeAll(async () => {
    store = await openEventsStore({ path: ':memory:' });
    // Two MAX_A rows whose per-account / per-backend token sums cross 2^53, and
    // one row whose SINGLE 4-class sum alone crosses 2^53 (burnRows per-row path).
    store.events.insert({
      tsMs: NOW - 3 * DAY, backend: 'claude_code', account: 'MAX_A', source: 'claude-jsonl',
      eventType: 'api_request', rawRef: 'big:1', inputTokens: BIG, cacheReadTokens: BIG, skillName: 'huge',
    });
    store.events.insert({
      tsMs: NOW - 2 * DAY, backend: 'claude_code', account: 'MAX_A', source: 'claude-jsonl',
      eventType: 'api_request', rawRef: 'big:2', inputTokens: BIG, outputTokens: BIG,
      cacheReadTokens: BIG, cacheCreationTokens: BIG, skillName: 'huge', ok: true,
    });
  });
  afterAll(() => store.close());

  const tokBig = (r: EventRow): number =>
    (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);

  it('burnRows folds per-row tokens in JS — no ERR_OUT_OF_RANGE, matches the JS reference', () => {
    const rows = store.events.list({ sinceTsMs: 0 });
    expect(() => store.eventsAggregates.burnRows(0)).not.toThrow();
    expect(store.eventsAggregates.burnRows(0)).toEqual(
      rows.map((r) => ({ account: r.account, tsMs: r.tsMs, tokens: tokBig(r) })),
    );
  });

  it('tokenSumsByBackend / cacheTokensByAccount / skillAggregates cross 2^53 without throwing', () => {
    const rows = store.events.list({ sinceTsMs: 0 });
    expect(() => store.eventsAggregates.tokenSumsByBackend(0)).not.toThrow();
    expect(() => store.eventsAggregates.cacheTokensByAccount(0)).not.toThrow();
    expect(() => store.eventsAggregates.skillAggregates(0)).not.toThrow();

    const backendTotal = rows.reduce((s, r) => s + tokBig(r), 0);
    expect(store.eventsAggregates.tokenSumsByBackend(0)).toEqual([{ backend: 'claude_code', tokens: backendTotal }]);
    expect(backendTotal).toBeGreaterThan(Number.MAX_SAFE_INTEGER); // the boundary is genuinely crossed

    const cache = store.eventsAggregates.cacheTokensByAccount(0)[0];
    expect(cache?.readTokens).toBe(rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0));

    const skill = store.eventsAggregates.skillAggregates(0)[0];
    expect(skill?.totalTokens).toBe(backendTotal);
    expect(skill?.invocations).toBe(2);
    expect(skill?.okCount).toBe(1);
  });
});
