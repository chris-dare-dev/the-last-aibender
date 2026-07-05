/**
 * THE [X2] AUDIT (task brief; plan §7 [X2] row "automated audit query shows
 * zero raw identifiers in any committed file or stored row"; M3 DoD
 * "automated audit proves zero identity-bearing rows in the store").
 *
 * This suite pushes SYNTHESIZED fixtures through EVERY collector source —
 * JSONL watcher, statusline tee, OAuth poller, OTLP receiver, OpenCode SSE +
 * durable replay + db scrape, Cost Explorer, CloudWatch, LM Studio capture,
 * hooks endpoint — including ADVERSARIAL inputs whose identity-shaped
 * content is CONSTRUCTED AT RUNTIME (no committed file may carry an email
 * shape, a 12-digit run, or a token shape — the fixture policy screens the
 * corpus itself). Then it sweeps EVERY COLUMN of EVERY ROW of EVERY events-
 * store table with the audit detectors and asserts zero hits and
 * labels-only account values.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_LABELS, EVENT_SOURCES, type EventSource } from '@aibender/protocol';
import { openEventsStore, type EventsStore } from '@aibender/schema';
import { buildFakeOpencodeDb } from '@aibender/testkit';

import { openOpencodeDbReadOnly } from '../adapters/opencode/dbAccess.js';
import { createCloudWatchPoller } from './aws/cloudwatch.js';
import { createCostExplorerPoller } from './aws/costExplorer.js';
import { startHooksServer } from './hooks/server.js';
import { findIdentityShapes } from './identity.js';
import { createApiRequestJoiner } from './ingest.js';
import { createAccountConfigWatcher } from './jsonl/accountWatcher.js';
import { createLmStudioUsageCapture } from './lmstudio/usageCapture.js';
import { createOpencodeDbScraper } from './opencode/dbScrape.js';
import {
  normalizeDurableOpencodeEvent,
  normalizeLiveOpencodeEvent,
} from './opencode/normalize.js';
import { startOtlpReceiver } from './otlp/receiver.js';
import { createIdleAccountOauthPoller } from './quota/oauthPoller.js';
import { createQuotaTeeIngestor } from './quota/teeFile.js';

// ---------------------------------------------------------------------------
// Runtime-constructed identity shapes (NEVER as literals in this file)
// ---------------------------------------------------------------------------

const EMAIL = ['synthetic.owner', 'example.invalid'].join('@');
const AWS_ID = '7'.repeat(12);
const TOKEN = ['sk-', 'synthfake', 'abcdef123456'].join('');

const EVENTS_TABLES = ['events', 'quota_snapshots', 'session_outcomes', 'prices'] as const;

// ---------------------------------------------------------------------------
// X-2: the audit source list is DERIVED from the protocol's EVENT_SOURCES —
// not a hardcoded literal — so a NEW source added to the vocabulary cannot
// silently escape the sweep. Every EVENT_SOURCE is classified into exactly one
// bucket; the test below asserts the buckets PARTITION EVENT_SOURCES, failing
// loudly if a source is defined but left unclassified (hence unswept).
// ---------------------------------------------------------------------------

/** Sources whose rows land in the `events` table (the sweep's primary target). */
const EVENTS_TABLE_SOURCES: readonly EventSource[] = [
  'claude-jsonl',
  'claude-otel',
  'hooks',
  'opencode-sse',
  'opencode-db',
  'bedrock-cost-explorer',
  'bedrock-cloudwatch',
  'lmstudio',
];

/**
 * Sources exercised by this audit but whose rows land in a DIFFERENT store,
 * not the `events` table — so they are swept by the all-tables column scan
 * (EVENTS_TABLES) rather than the events-source check. `claude-quota` writes
 * quota_snapshots (statusline tee + OAuth poller).
 */
const NON_EVENTS_TABLE_SOURCES: readonly EventSource[] = ['claude-quota'];

/**
 * Sources DEFINED in the vocabulary but not yet IMPLEMENTED, so no ingest path
 * exists to exercise. `ent-analytics` is the optional admin-key-gated ENT org
 * analytics adapter (events.ts). Listed EXPLICITLY: when it is implemented, it
 * must move to EVENTS_TABLE_SOURCES (or the coverage assertion below fails).
 */
const UNIMPLEMENTED_SOURCES: readonly EventSource[] = ['ent-analytics'];

describe('THE [X2] audit — zero identity-bearing rows across every source', () => {
  let dir: string;
  let store: EventsStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aibender-x2-'));
    store = await openEventsStore({ path: ':memory:' });
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0, windowMs: 0 });

    // -- source 1: JSONL watcher (transcript + history + usage-data), with
    //    adversarial identity content in free text --------------------------
    const configDir = join(dir, 'max-a');
    mkdirSync(join(configDir, 'projects', 'synth'), { recursive: true });
    mkdirSync(join(configDir, 'usage-data', 'facets'), { recursive: true });
    mkdirSync(join(configDir, 'usage-data', 'session-meta'), { recursive: true });
    writeFileSync(
      join(configDir, 'projects', 'synth', 'synth-native-1.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          uuid: 'synth-uuid-1',
          sessionId: 'synth-native-1',
          timestamp: '2026-01-01T00:00:10.000Z',
          requestId: 'req_synth_0001',
          message: {
            role: 'assistant',
            model: 'claude-synth-4',
            content: [
              { type: 'tool_use', id: 'toolu_synth_1', name: 'Read', input: { file_path: '/synthetic/a.ts' } },
            ],
            usage: {
              input_tokens: 6,
              output_tokens: 244,
              cache_read_input_tokens: 17643,
              cache_creation_input_tokens: 20144,
              cache_creation: { ephemeral_1h_input_tokens: 20144, ephemeral_5m_input_tokens: 0 },
            },
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'synth-uuid-2',
          sessionId: 'synth-native-1',
          timestamp: '2026-01-01T00:00:20.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_synth_1', is_error: false }],
          },
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(configDir, 'history.jsonl'),
      `${JSON.stringify({ display: `mail ${EMAIL} about ${AWS_ID}`, timestamp: 1767225600, sessionId: 'synth-native-1' })}\n`,
    );
    writeFileSync(
      join(configDir, 'usage-data', 'facets', 'synth-native-1.json'),
      JSON.stringify({
        outcome: `achieved for ${EMAIL}`, // adversarial: scrubbed at ingest
        friction_detail: `account ${AWS_ID} saw ${TOKEN}`,
        goal_categories: ['synthetic'],
      }),
    );
    writeFileSync(
      join(configDir, 'usage-data', 'session-meta', 'synth-native-1.json'),
      JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
    );
    const watcher = createAccountConfigWatcher({
      account: 'MAX_A',
      configDir,
      events: store.events,
      sessionOutcomes: store.sessionOutcomes,
      joiner,
    });
    watcher.scan();

    // -- source 2: statusline tee + OAuth poller ---------------------------
    const quotaDir = join(dir, 'quota');
    mkdirSync(quotaDir, { recursive: true });
    writeFileSync(
      join(quotaDir, 'MAX_A.json'),
      JSON.stringify({
        session_id: 'synth-native-1',
        rate_limits: {
          five_hour: { used_percentage: 41.5, resets_at: '2026-07-04T12:00:00Z' },
          seven_day: { used_percentage: 12, resets_at: '2026-07-08T00:00:00Z' },
        },
      }),
    );
    createQuotaTeeIngestor({ quotaDir, store: store.quotaSnapshots }).poll();
    await createIdleAccountOauthPoller({
      client: {
        fetchUsage: async () => ({
          status: 'ok',
          windows: [{ window: '5h', usedPct: 50, resetsAtMs: 2_000_000 }],
        }),
      },
      store: store.quotaSnapshots,
      accounts: ['MAX_B'],
      isIdle: () => true,
      nowMs: () => 1_000,
    }).tick();

    // -- source 3: OTLP receiver with adversarial identity attributes ------
    const receiver = await startOtlpReceiver({ events: store.events, joiner, port: 0 });
    await fetch(`${receiver.url}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: 'account', value: { stringValue: 'MAX_A' } },
                { key: 'user.email', value: { stringValue: EMAIL } },
                { key: 'user.account_uuid', value: { stringValue: `uuid-${AWS_ID}` } },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: String(1_767_225_610_000 * 1e6),
                    attributes: [
                      { key: 'event.name', value: { stringValue: 'api_request' } },
                      { key: 'request_id', value: { stringValue: 'req_synth_0001' } },
                      { key: 'session.id', value: { stringValue: 'synth-native-1' } },
                      { key: 'user.email', value: { stringValue: EMAIL } },
                      { key: 'skill.name', value: { stringValue: 'synth-skill' } },
                      { key: 'cost_usd', value: { doubleValue: 0.1 } },
                    ],
                  },
                  {
                    timeUnixNano: String(1_767_225_611_000 * 1e6),
                    attributes: [
                      { key: 'event.name', value: { stringValue: 'tool_result' } },
                      { key: 'session.id', value: { stringValue: 'synth-native-1' } },
                      { key: 'organization.id', value: { stringValue: AWS_ID } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    await receiver.close();

    // -- sources 4+5: OpenCode SSE live + durable + db scrape --------------
    const live = normalizeLiveOpencodeEvent({
      account: 'AWS_DEV',
      id: 'evt_synth00000042',
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'ses_synth00000001',
          cost: 0.05,
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: 'openai.gpt-synth',
          providerID: 'amazon-bedrock',
          time: { created: 1_783_097_463_410, completed: 1_783_097_465_291 },
        },
      },
      fallbackTsMs: 0,
    });
    if (live.kind === 'row') store.events.insert(live.row);
    store.events.insert(
      normalizeDurableOpencodeEvent({
        account: 'AWS_DEV',
        sessionId: 'ses_synth00000001',
        seq: 7,
        payload: { type: 'message.updated.1', data: {} },
        fallbackTsMs: 1,
      }),
    );
    const dbPath = join(dir, 'opencode.db');
    buildFakeOpencodeDb({
      path: dbPath,
      sessions: [{ sessionId: 'ses_synth00000001', eventTypes: ['session.created'] }],
    });
    const guarded = openOpencodeDbReadOnly({ path: dbPath });
    createOpencodeDbScraper({
      db: guarded,
      events: store.events,
      account: 'AWS_DEV',
      nowMs: () => 2,
    }).scrape();
    guarded.close();

    // -- source 6: AWS pollers (fakes) --------------------------------------
    await createCostExplorerPoller({
      client: {
        getBedrockDailyCost: async () => ({
          resultsByTime: [
            {
              timePeriod: { start: '2026-07-02', end: '2026-07-03' },
              total: { unblendedCost: { amount: '1.25', unit: 'USD' } },
            },
          ],
        }),
      },
      events: store.events,
      account: 'AWS_DEV',
      nowMs: () => Date.parse('2026-07-04T06:00:00Z'),
    }).poll();
    await createCloudWatchPoller({
      client: {
        fetchBedrockSamples: async () => [
          {
            modelId: 'us.anthropic.claude-synth-4',
            periodStartMs: 1_767_225_600_000,
            periodSeconds: 300,
            inputTokens: 100,
            outputTokens: 20,
            throttles: 1,
          },
        ],
      },
      events: store.events,
      account: 'AWS_DEV',
      isActive: () => true,
      nowMs: () => 10 * 60 * 1000,
    }).poll();

    // -- source 7: LM Studio inline capture ---------------------------------
    createLmStudioUsageCapture({ events: store.events, nowMs: () => 777 }).capture({
      content: 'synthesized',
      model: 'synth-8b-q4',
      durationMs: 12,
      ttlSeconds: 1800,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });

    // -- source 8: hooks endpoint with adversarial body content -------------
    const hooks = await startHooksServer({ events: store.events, port: 0, nowMs: () => 999 });
    await fetch(`${hooks.url}/hooks/v1/MAX_B`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'synth-native-9',
        tool_name: 'Bash',
        tool_input: { command: `curl -u ${EMAIL}:${TOKEN} https://${AWS_ID}.example.invalid` },
        tool_output: { ok: true },
      }),
    });
    await hooks.close();

    // -- companions: a pinned price row (prices table must be swept too) ----
    store.prices.upsert({
      provider: 'anthropic',
      model: 'claude-synth-4',
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      source: 'litellm-pinned',
    });
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('X-2: the audit buckets PARTITION EVENT_SOURCES (a new source cannot escape the sweep)', () => {
    // Derive the coverage from the protocol's single source of truth. If a
    // developer adds a source to EVENT_SOURCES but forgets to classify it here,
    // this fails LOUDLY — the audit can never silently under-cover.
    const classified = new Set<EventSource>([
      ...EVENTS_TABLE_SOURCES,
      ...NON_EVENTS_TABLE_SOURCES,
      ...UNIMPLEMENTED_SOURCES,
    ]);
    const defined = new Set<EventSource>(EVENT_SOURCES);
    // No overlap between buckets (each source classified exactly once).
    expect(classified.size).toBe(
      EVENTS_TABLE_SOURCES.length + NON_EVENTS_TABLE_SOURCES.length + UNIMPLEMENTED_SOURCES.length,
    );
    // Every DEFINED source is classified — the "no source left unswept" gate.
    const unclassified = [...defined].filter((s) => !classified.has(s));
    expect(unclassified, `EVENT_SOURCES not classified by the audit: ${unclassified.join(', ')}`)
      .toEqual([]);
    // And no classified source is stale (removed from the vocabulary).
    const stale = [...classified].filter((s) => !defined.has(s));
    expect(stale, `audit classifies sources not in EVENT_SOURCES: ${stale.join(', ')}`).toEqual([]);
  });

  it('ingested rows from every events-table source (the audit has teeth)', () => {
    const sources = new Set(store.events.list().map((row) => row.source));
    // Iterate the DERIVED list, not a hardcoded literal.
    for (const expected of EVENTS_TABLE_SOURCES) {
      expect(sources.has(expected), `source ${expected} ingested`).toBe(true);
    }
    // The non-events-table sources landed in their own stores.
    expect(store.quotaSnapshots.list().length).toBeGreaterThanOrEqual(3); // claude-quota
    expect(store.sessionOutcomes.list().length).toBeGreaterThanOrEqual(1);
    expect(store.prices.list().length).toBeGreaterThanOrEqual(1);
  });

  it('EVERY column of EVERY row of EVERY table is identity-free', () => {
    for (const table of EVENTS_TABLES) {
      const rows = store.driver.prepare(`SELECT * FROM ${table}`).all();
      expect(rows.length, `${table} rows swept`).toBeGreaterThan(0);
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          const hits = findIdentityShapes(value);
          expect(
            hits,
            `${table}.${column} = ${JSON.stringify(value)} carries ${hits.join(', ')}`,
          ).toEqual([]);
        }
      }
    }
  });

  it('account columns carry ONLY the five placeholder labels', () => {
    for (const table of ['events', 'quota_snapshots', 'session_outcomes'] as const) {
      const rows = store.driver.prepare(`SELECT DISTINCT account FROM ${table}`).all();
      for (const row of rows) {
        expect(ACCOUNT_LABELS as readonly string[]).toContain(String(row['account']));
      }
    }
  });

  it('the store backstop still throws on a direct identity-bearing insert', () => {
    expect(() =>
      store.events.insert({
        tsMs: 0,
        backend: 'claude_code',
        account: 'MAX_A',
        source: 'hooks',
        eventType: `contact ${EMAIL}`,
        rawRef: 'audit-backstop-1',
      }),
    ).toThrowError(/identity/i);
  });
});
