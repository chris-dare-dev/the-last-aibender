/**
 * BE-5 source 1 suite (plan §9.2 BE-5 rows):
 *   positive — JSONL line → events row with four token classes + cache-TTL
 *              split; usage-data + history parsing; label from watch root
 *   negative — malformed JSONL line skipped, tail continues
 *   edge     — file rotation/truncation mid-tail; duplicate (backend,
 *              raw_ref) upsert on re-tail
 */

import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEventsStore, type EventsStore } from '@aibender/schema';

import { createApiRequestJoiner, type ApiRequestJoiner } from '../ingest.js';
import { createAccountConfigWatcher, type AccountConfigWatcher } from './accountWatcher.js';
import { normalizeHistoryLine } from './history.js';
import { FileTailer } from './tailer.js';
import { normalizeTranscriptLine } from './transcripts.js';
import { normalizeFacetsFile, normalizeSessionMetaFile } from './usageData.js';

// ---------------------------------------------------------------------------
// Synthesized fixture lines ([X2]: placeholder labels, synthetic ids only)
// ---------------------------------------------------------------------------

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  uuid: 'synth-uuid-1',
  sessionId: 'synth-native-1',
  timestamp: '2026-01-01T00:00:10.000Z',
  requestId: 'req_synth_0001',
  message: {
    role: 'assistant',
    model: 'claude-synth-4',
    content: [
      { type: 'text', text: 'synthesized turn' },
      {
        type: 'tool_use',
        id: 'toolu_synth_1',
        name: 'Read',
        input: { file_path: '/synthetic/read-me.ts' },
      },
    ],
    usage: {
      input_tokens: 6,
      cache_creation_input_tokens: 20144,
      cache_read_input_tokens: 17643,
      output_tokens: 244,
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 20144, ephemeral_5m_input_tokens: 0 },
    },
  },
});

const SKILL_LINE = JSON.stringify({
  type: 'assistant',
  uuid: 'synth-uuid-2',
  sessionId: 'synth-native-1',
  timestamp: '2026-01-01T00:00:20.000Z',
  message: {
    role: 'assistant',
    model: 'claude-synth-4',
    content: [
      { type: 'tool_use', id: 'toolu_synth_2', name: 'Skill', input: { skill: 'synth-skill' } },
      {
        type: 'tool_use',
        id: 'toolu_synth_3',
        name: 'mcp__synth-server__do_thing',
        input: {},
      },
    ],
  },
});

const TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  uuid: 'synth-uuid-3',
  sessionId: 'synth-native-1',
  timestamp: '2026-01-01T00:00:30.000Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_synth_1', is_error: true }],
  },
});

// ---------------------------------------------------------------------------
// Unit: normalizers
// ---------------------------------------------------------------------------

describe('normalizeTranscriptLine', () => {
  it('extracts all four token classes + the 5m/1h cache-TTL split as a join half', () => {
    const outcome = normalizeTranscriptLine({ account: 'MAX_A', line: ASSISTANT_LINE });
    expect(outcome.kind).toBe('normalized');
    if (outcome.kind !== 'normalized') return;
    expect(outcome.apiRequest?.requestId).toBe('req_synth_0001');
    expect(outcome.apiRequest?.account).toBe('MAX_A');
    expect(outcome.apiRequest?.usage).toEqual({
      inputTokens: 6,
      outputTokens: 244,
      cacheReadTokens: 17643,
      cacheCreationTokens: 20144,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 20144,
    });
    // The tool_use content block becomes an attribution row with file_refs.
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]?.eventType).toBe('tool_use');
    expect(outcome.rows[0]?.toolName).toBe('Read');
    expect(outcome.rows[0]?.fileRefs).toEqual(['/synthetic/read-me.ts']);
  });

  it('attributes Skill and MCP tool_use blocks (leaderboard inputs)', () => {
    const outcome = normalizeTranscriptLine({ account: 'MAX_B', line: SKILL_LINE });
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.rows[0]?.skillName).toBe('synth-skill');
    expect(outcome.rows[1]?.mcpServer).toBe('synth-server');
  });

  it('maps tool_result errors to ok:false/errorKind:error', () => {
    const outcome = normalizeTranscriptLine({ account: 'MAX_A', line: TOOL_RESULT_LINE });
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.rows[0]?.eventType).toBe('tool_result');
    expect(outcome.rows[0]?.ok).toBe(false);
    expect(outcome.rows[0]?.errorKind).toBe('error');
  });

  it('returns malformed for unparseable lines and ignored for non-metric types', () => {
    expect(normalizeTranscriptLine({ account: 'MAX_A', line: '{torn' }).kind).toBe('malformed');
    expect(
      normalizeTranscriptLine({
        account: 'MAX_A',
        line: JSON.stringify({ type: 'ai-title', title: 'synth' }),
      }).kind,
    ).toBe('ignored');
  });
});

describe('usage-data + history normalizers', () => {
  it('facets → session_outcomes row with scrubbed verbatim facets_json', () => {
    const row = normalizeFacetsFile({
      account: 'MAX_A',
      sessionUuid: 'synth-native-1',
      json: JSON.stringify({ outcome: 'mostly_achieved', friction_detail: 'some friction' }),
      capturedAtMs: 42,
    });
    expect(row?.outcome).toBe('mostly_achieved');
    expect(row?.friction).toBe('some friction');
    expect(row?.rawRef).toBe('facets:synth-native-1');
  });

  it('facets identity content is DROPPED at ingest (runtime-built shapes)', () => {
    // Identity-shaped strings are CONSTRUCTED at runtime — no committed
    // fixture may carry them ([X2] fixture policy).
    const email = ['synthetic.person', 'example.invalid'].join('@');
    const awsId = '4'.repeat(12);
    const row = normalizeFacetsFile({
      account: 'MAX_A',
      sessionUuid: 'synth-native-1',
      json: JSON.stringify({
        outcome: `helped ${email}`,
        friction_detail: `account ${awsId} throttled`,
      }),
      capturedAtMs: 42,
    });
    expect(row?.outcome).not.toContain(email);
    expect(row?.friction).not.toContain(awsId);
    expect(row?.facetsJson).not.toContain(email);
    expect(row?.facetsJson).not.toContain(awsId);
  });

  it('session-meta → events row with token totals', () => {
    const row = normalizeSessionMetaFile({
      account: 'ENT',
      sessionUuid: 'synth-native-2',
      json: JSON.stringify({ input_tokens: 100, output_tokens: 50, duration_minutes: 12 }),
      capturedAtMs: 99,
    });
    expect(row?.eventType).toBe('session_meta');
    expect(row?.inputTokens).toBe(100);
    expect(row?.outputTokens).toBe(50);
  });

  it('history line → user_prompt row; display text never stored', () => {
    const outcome = normalizeHistoryLine({
      account: 'MAX_A',
      line: JSON.stringify({
        display: 'a synthesized prompt',
        timestamp: 1_767_225_600, // epoch seconds
        project: '/synthetic/project',
        sessionId: 'synth-native-1',
      }),
    });
    if (outcome.kind !== 'row') throw new Error('expected row');
    expect(outcome.row.eventType).toBe('user_prompt');
    expect(outcome.row.tsMs).toBe(1_767_225_600_000);
    expect(JSON.stringify(outcome.row)).not.toContain('a synthesized prompt');
  });
});

// ---------------------------------------------------------------------------
// FileTailer: rotation/truncation mid-tail (plan §9.2 BE-5 edge)
// ---------------------------------------------------------------------------

describe('FileTailer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aibender-tailer-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields complete lines only; a torn partial line waits for its newline', () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, 'line-one\nline-tw');
    const tailer = new FileTailer(path);
    expect(tailer.poll().lines).toEqual(['line-one']);
    appendFileSync(path, 'o\nline-three\n');
    expect(tailer.poll().lines).toEqual(['line-two', 'line-three']);
  });

  it('truncation mid-tail resets to the top and reports it', () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, 'one-long-line\ntwo-long-line\n');
    const tailer = new FileTailer(path);
    tailer.poll();
    writeFileSync(path, 'rewritten\n'); // strictly shorter than the offset
    const result = tailer.poll();
    expect(result.truncated).toBe(true);
    expect(result.lines).toEqual(['rewritten']);
  });

  it('rotation (file vanished) reports removed', () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, 'one\n');
    const tailer = new FileTailer(path);
    tailer.poll();
    renameSync(path, join(dir, 'a.jsonl.rotated'));
    expect(tailer.poll().removed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AccountConfigWatcher end-to-end over a synthesized config dir
// ---------------------------------------------------------------------------

describe('createAccountConfigWatcher', () => {
  let dir: string;
  let store: EventsStore;
  let joiner: ApiRequestJoiner;
  let watcher: AccountConfigWatcher;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aibender-configdir-'));
    mkdirSync(join(dir, 'projects', 'synth-project'), { recursive: true });
    mkdirSync(join(dir, 'usage-data', 'facets'), { recursive: true });
    mkdirSync(join(dir, 'usage-data', 'session-meta'), { recursive: true });
    store = await openEventsStore({ path: ':memory:' });
    joiner = createApiRequestJoiner(store.events, { nowMs: () => 0, windowMs: 0 });
    watcher = createAccountConfigWatcher({
      account: 'MAX_A',
      configDir: dir,
      events: store.events,
      sessionOutcomes: store.sessionOutcomes,
      joiner,
    });
  });
  afterEach(() => {
    watcher.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses non-claude labels (watch roots are claude config dirs)', () => {
    expect(() =>
      createAccountConfigWatcher({
        account: 'LOCAL',
        configDir: dir,
        events: store.events,
        sessionOutcomes: store.sessionOutcomes,
        joiner,
      }),
    ).toThrowError(/claude_code/);
  });

  it('ingests transcripts + history + usage-data; the label comes from the root', () => {
    const transcript = join(dir, 'projects', 'synth-project', 'synth-native-1.jsonl');
    writeFileSync(transcript, `${ASSISTANT_LINE}\n${SKILL_LINE}\n${TOOL_RESULT_LINE}\n`);
    writeFileSync(
      join(dir, 'history.jsonl'),
      `${JSON.stringify({ display: 'p', timestamp: 1767225600, sessionId: 'synth-native-1' })}\n`,
    );
    writeFileSync(
      join(dir, 'usage-data', 'facets', 'synth-native-1.json'),
      JSON.stringify({ outcome: 'achieved' }),
    );
    writeFileSync(
      join(dir, 'usage-data', 'session-meta', 'synth-native-1.json'),
      JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
    );

    watcher.scan();
    joiner.flush(0);

    const rows = store.events.list();
    // api_request (joined-flush) + 3 tool_use + 1 tool_result + user_prompt
    // + session_meta
    expect(rows.map((row) => row.eventType).sort()).toEqual([
      'api_request',
      'session_meta',
      'tool_result',
      'tool_use',
      'tool_use',
      'tool_use',
      'user_prompt',
    ]);
    for (const row of rows) expect(row.account).toBe('MAX_A');
    const outcomes = store.sessionOutcomes.list();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe('achieved');
  });

  it('a malformed line is skipped and the tail continues (negative row)', () => {
    const transcript = join(dir, 'projects', 'synth-project', 'synth-native-1.jsonl');
    writeFileSync(transcript, `{torn json\n${SKILL_LINE}\n`);
    watcher.scan();
    expect(watcher.stats().malformedLines).toBe(1);
    // The line AFTER the malformed one still landed.
    expect(store.events.list().map((row) => row.eventType)).toContain('tool_use');
  });

  it('re-tailing after truncation never duplicates rows (dedupe edge)', () => {
    const transcript = join(dir, 'projects', 'synth-project', 'synth-native-1.jsonl');
    writeFileSync(transcript, `${SKILL_LINE}\n${TOOL_RESULT_LINE}\n`);
    watcher.scan();
    const countAfterFirst = store.events.list().length;

    // Truncate to a prefix (the CLI rewrote the file), then re-append.
    writeFileSync(transcript, `${SKILL_LINE}\n`);
    watcher.scan();
    appendFileSync(transcript, `${TOOL_RESULT_LINE}\n`);
    watcher.scan();

    expect(watcher.stats().truncationsSeen).toBeGreaterThanOrEqual(1);
    expect(store.events.list().length).toBe(countAfterFirst); // no duplicates
  });

  it('rotation: successor file is discovered and overlap dedupes', () => {
    const transcript = join(dir, 'projects', 'synth-project', 'synth-native-1.jsonl');
    writeFileSync(transcript, `${SKILL_LINE}\n`);
    watcher.scan();
    const before = store.events.list().length;

    renameSync(transcript, join(dir, 'projects', 'synth-project', 'synth-native-1a.jsonl'));
    watcher.scan(); // old tailer dropped, successor tailed from byte 0
    watcher.scan();
    expect(store.events.list().length).toBe(before); // identical rows deduped
  });

  it('usage-data files re-ingest only on mtime change', () => {
    const facets = join(dir, 'usage-data', 'facets', 'synth-native-9.json');
    writeFileSync(facets, JSON.stringify({ outcome: 'achieved' }));
    watcher.scan();
    watcher.scan(); // unchanged mtime → skipped, no extra insert attempts
    expect(store.sessionOutcomes.list()).toHaveLength(1);
  });

  // -- OS-3: the async, off-event-loop, mtime-scoped production pass ----------

  describe('scanAsync (OS-3)', () => {
    const proj = (name: string): string => join(dir, 'projects', 'synth-project', name);

    it('discovers + tails a transcript the same as the sync scan', async () => {
      writeFileSync(proj('synth-native-1.jsonl'), `${ASSISTANT_LINE}\n${SKILL_LINE}\n`);
      await watcher.scanAsync({ full: true });
      joiner.flush(0);
      const types = store.events.list().map((r) => r.eventType);
      expect(types).toContain('tool_use'); // the skill line landed
    });

    it('picks up an in-place APPEND to a known file (mtime-scoped re-offer)', async () => {
      const p = proj('synth-native-2.jsonl');
      writeFileSync(p, `${SKILL_LINE}\n`);
      await watcher.scanAsync({ full: true });
      const afterFirst = store.events.list().length;

      // Append WITHOUT touching the dir's child set (dir mtime may not bump on
      // a pure in-file append) — a NON-full incremental pass must still re-tail
      // the known file and pick up the new line.
      appendFileSync(p, `${TOOL_RESULT_LINE}\n`);
      await watcher.scanAsync({ full: false });
      expect(store.events.list().length).toBeGreaterThan(afterFirst);
    });

    it('discovers a NEW file added to the tree on a later pass', async () => {
      await watcher.scanAsync({ full: true });
      expect(store.events.list()).toHaveLength(0);
      // A brand-new session file appears; a full reconcile discovers it (a new
      // file bumps its parent dir's mtime, so an incremental pass would too).
      writeFileSync(proj('synth-native-3.jsonl'), `${SKILL_LINE}\n`);
      await watcher.scanAsync({ full: true });
      expect(store.events.list().map((r) => r.eventType)).toContain('tool_use');
    });

    it('truncation + rotation still dedupe through scanAsync', async () => {
      const p = proj('synth-native-4.jsonl');
      writeFileSync(p, `${SKILL_LINE}\n${TOOL_RESULT_LINE}\n`);
      await watcher.scanAsync({ full: true });
      const baseline = store.events.list().length;

      // Truncate-and-reappend: dedupe (backend, raw_ref) absorbs re-reads.
      writeFileSync(p, `${SKILL_LINE}\n`);
      await watcher.scanAsync({ full: true });
      appendFileSync(p, `${TOOL_RESULT_LINE}\n`);
      await watcher.scanAsync({ full: true });
      expect(watcher.stats().truncationsSeen).toBeGreaterThanOrEqual(1);
      expect(store.events.list().length).toBe(baseline); // no duplicate rows

      // Rotation: rename to a successor; the old tailer drops, the successor is
      // tailed from byte 0, dedupe absorbs the overlap.
      renameSync(p, proj('synth-native-4a.jsonl'));
      await watcher.scanAsync({ full: true });
      await watcher.scanAsync({ full: true });
      expect(store.events.list().length).toBe(baseline);
    });
  });
});
