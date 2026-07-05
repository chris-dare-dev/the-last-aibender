/**
 * Brief synthesis (plan §9.2 BE-7 edge row: "compaction summary reused when
 * present, local draft otherwise") — native-summary extraction, the
 * deterministic conflict surfacing, and the qwen-produces/Claude-reviews
 * pipeline over FAKES (down-as-state; nothing here can incur cost).
 */

import { describe, expect, it } from 'vitest';

import type { LmStudioClient } from '../adapters/lmstudio/index.js';
import {
  NATIVE_COMPACTION_SUMMARY_PREFIX,
  createBriefSynthesizer,
  extractClaims,
  extractNativeCompactionSummary,
  lmStudioBriefDrafter,
  renderConflictsSection,
  surfaceConflicts,
  type BriefDrafterPort,
  type BriefRefinerPort,
} from './briefs.js';

const NATIVE_SUMMARY =
  `${NATIVE_COMPACTION_SUMMARY_PREFIX} that ran out of context.\n` +
  'approach: streaming parser\nfiles: /synthetic/workspace/src/parser.ts';

function jsonl(lines: readonly unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

describe('extractNativeCompactionSummary', () => {
  it('finds the LAST synthetic continuation message; skips malformed lines', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'plain prompt' } }),
      'NOT JSON {{{',
      JSON.stringify({ type: 'user', message: { content: `${NATIVE_COMPACTION_SUMMARY_PREFIX} v1` } }),
      JSON.stringify({ type: 'assistant', message: { content: 'reply' } }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: NATIVE_SUMMARY }] },
      }),
    ].join('\n');
    expect(extractNativeCompactionSummary(text)).toBe(NATIVE_SUMMARY);
  });

  it('returns undefined when no compaction summary exists', () => {
    expect(
      extractNativeCompactionSummary(jsonl([{ type: 'user', message: { content: 'hi' } }])),
    ).toBeUndefined();
    expect(extractNativeCompactionSummary('')).toBeUndefined();
  });
});

describe('conflict surfacing (deterministic, never model-resolved)', () => {
  it('extracts key: value claims and surfaces disagreements verbatim per branch', () => {
    const claims = extractClaims('- approach: rewrite\n  DB: sqlite\nnoise line\n: empty key');
    expect(claims.get('approach')).toBe('rewrite');
    expect(claims.get('db')).toBe('sqlite');

    const conflicts = surfaceConflicts([
      { sessionId: 'ses_a', body: 'approach: rewrite\ndb: sqlite' },
      { sessionId: 'ses_b', body: 'approach: patch in place\ndb: sqlite' },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.key).toBe('approach');
    expect(conflicts[0]?.claims).toEqual([
      { sessionId: 'ses_a', value: 'rewrite' },
      { sessionId: 'ses_b', value: 'patch in place' },
    ]);

    const section = renderConflictsSection(conflicts);
    expect(section).toContain('## Conflicts');
    expect(section).toContain('rewrite');
    expect(section).toContain('patch in place');
  });

  it('agreeing branches surface nothing', () => {
    expect(
      surfaceConflicts([
        { sessionId: 'ses_a', body: 'approach: rewrite' },
        { sessionId: 'ses_b', body: 'approach: rewrite' },
      ]),
    ).toHaveLength(0);
    expect(renderConflictsSection([])).toBe('');
  });
});

describe('createBriefSynthesizer.distill', () => {
  it('REUSES the native compaction summary when present (provenance native-summary)', async () => {
    const drafter: BriefDrafterPort = {
      draft: async () => {
        throw new Error('the drafter must not be consulted when a native summary exists');
      },
    };
    const synthesizer = createBriefSynthesizer({ drafter });
    const result = await synthesizer.distill({
      goal: 'continuation brief',
      sessionId: 'ses_a',
      transcriptText: jsonl([{ type: 'user', message: { content: NATIVE_SUMMARY } }]),
    });
    expect(result.provenance).toBe('native-summary');
    expect(result.body).toBe(NATIVE_SUMMARY);
  });

  it('drafts locally otherwise; refiner upgrades provenance to refined', async () => {
    const drafter: BriefDrafterPort = {
      draft: async (request) => ({ state: 'ok', body: `draft for ${request.sourceSessionIds[0]}` }),
    };
    const refiner: BriefRefinerPort = {
      refine: async (draftBody) => ({ state: 'ok', body: `${draftBody} (reviewed)` }),
    };
    const local = await createBriefSynthesizer({ drafter }).distill({
      goal: 'continuation brief',
      sessionId: 'ses_a',
    });
    expect(local).toEqual({ body: 'draft for ses_a', provenance: 'local-draft' });

    const refined = await createBriefSynthesizer({ drafter, refiner }).distill({
      goal: 'continuation brief',
      sessionId: 'ses_a',
    });
    expect(refined).toEqual({ body: 'draft for ses_a (reviewed)', provenance: 'refined' });
  });

  it('DOWN IS A STATE: drafter down/throwing degrades to the deterministic fallback, never rejects', async () => {
    const down: BriefDrafterPort = { draft: async () => ({ state: 'down' }) };
    const throwing: BriefDrafterPort = {
      draft: async () => {
        throw new Error('synthetic transport explosion');
      },
    };
    for (const drafter of [down, throwing]) {
      const result = await createBriefSynthesizer({ drafter }).distill({
        goal: 'continuation brief',
        sessionId: 'ses_a',
        contextLines: ['cwd: /synthetic/workspace'],
      });
      expect(result.provenance).toBe('local-draft');
      expect(result.body).toContain('Deterministic harness fallback');
      expect(result.body).toContain('ses_a');
    }
  });

  it('a failing refiner keeps the local draft (never loses work)', async () => {
    const drafter: BriefDrafterPort = { draft: async () => ({ state: 'ok', body: 'the draft' }) };
    const refiner: BriefRefinerPort = {
      refine: async () => ({ state: 'error', message: 'reviewer unavailable' }),
    };
    const result = await createBriefSynthesizer({ drafter, refiner }).distill({
      goal: 'g',
      sessionId: 'ses_a',
    });
    expect(result).toEqual({ body: 'the draft', provenance: 'local-draft' });
  });
});

describe('createBriefSynthesizer.synthesizeMergeBrief', () => {
  it('appends the conflicts section STRUCTURALLY after any model pass', async () => {
    // A hostile drafter that tries to resolve the disagreement silently.
    const drafter: BriefDrafterPort = {
      draft: async () => ({ state: 'ok', body: 'All branches agree: rewrite. No conflicts.' }),
    };
    const result = await createBriefSynthesizer({ drafter }).synthesizeMergeBrief({
      branches: [
        { sessionId: 'ses_a', body: 'approach: rewrite' },
        { sessionId: 'ses_b', body: 'approach: patch in place' },
      ],
    });
    // The disagreement is SURFACED regardless of what the model claimed.
    expect(result.body).toContain('## Conflicts');
    expect(result.body).toContain('patch in place');
  });

  it('no conflicts → clean fused brief without the section', async () => {
    const result = await createBriefSynthesizer().synthesizeMergeBrief({
      branches: [
        { sessionId: 'ses_a', body: 'approach: rewrite' },
        { sessionId: 'ses_b', body: 'approach: rewrite' },
      ],
    });
    expect(result.body).not.toContain('## Conflicts');
  });
});

describe('lmStudioBriefDrafter (BE-4 adapter binding — fakes only)', () => {
  const completion = { model: 'synthetic-8b', durationMs: 5, ttlSeconds: 1800 };

  it('ok → draft body; down → state down; error → state error; blank → error', async () => {
    const make = (content: string | 'down' | 'error'): LmStudioClient => ({
      chat: async () =>
        content === 'down'
          ? { state: 'down', reason: 'unreachable' }
          : content === 'error'
            ? { state: 'error', status: 500, message: 'synthetic failure' }
            : { state: 'ok', value: { content, ...completion } },
    });

    const ok = lmStudioBriefDrafter({ client: make('a fine draft'), model: 'synthetic-8b' });
    expect(await ok.draft({ goal: 'g', sourceSessionIds: ['ses_a'], material: 'm' })).toEqual({
      state: 'ok',
      body: 'a fine draft',
    });

    const down = lmStudioBriefDrafter({ client: make('down'), model: 'synthetic-8b' });
    expect(await down.draft({ goal: 'g', sourceSessionIds: ['ses_a'], material: 'm' })).toEqual({
      state: 'down',
    });

    const error = lmStudioBriefDrafter({ client: make('error'), model: 'synthetic-8b' });
    expect(
      (await error.draft({ goal: 'g', sourceSessionIds: ['ses_a'], material: 'm' })).state,
    ).toBe('error');

    const blank = lmStudioBriefDrafter({ client: make('   '), model: 'synthetic-8b' });
    expect(
      (await blank.draft({ goal: 'g', sourceSessionIds: ['ses_a'], material: 'm' })).state,
    ).toBe('error');
  });
});
