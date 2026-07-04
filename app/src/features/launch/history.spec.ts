/**
 * FE-5 launch history tests (plan §9.2 FE-5; local store, M2 slice).
 *
 *  positive — record/list newest-first, persistence round-trip, subscribe;
 *  negative — [X2] discipline: non-placeholder labels refused at record time
 *             and dropped at load time; identity-shaped free text masked;
 *  edge     — bounded ring at the limit; corrupt/tampered persisted payloads
 *             reset/skip without throwing; preview truncation boundary.
 */

import { describe, expect, it } from 'vitest';

import { assertSynthesizedSafeText } from '@aibender/testkit';

import {
  DEFAULT_HISTORY_LIMIT,
  LAUNCH_HISTORY_STORAGE_KEY,
  LaunchHistoryStore,
  MASKED,
  PROMPT_PREVIEW_CHARS,
  maskIdentityShapedText,
  type StorageLike,
} from './history.ts';

class FakeStorage implements StorageLike {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

// Identity-shaped strings are runtime-built so no scanner-shaped literal is
// ever committed to this public repo (testkit index.spec.ts convention).
const emailish = ['synth.user', 'example.com'].join('@');
const awsIdish = '123456'.repeat(2);
const tokenish = ['sk', 'fake0token0fake0'].join('-');

const baseDraft = {
  kind: 'prompt',
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'sdk',
  cwd: '/synthetic/workspace',
  purpose: 'history test',
  promptText: 'synthesized prompt',
  outcome: 'accepted',
  sessionId: 'ses_fake_1',
} as const;

describe('LaunchHistoryStore (positive)', () => {
  it('records newest-first with the injected clock', () => {
    let t = 1000;
    const store = new LaunchHistoryStore({ now: () => (t += 1) });
    store.record({ ...baseDraft, purpose: 'first' });
    store.record({ ...baseDraft, purpose: 'second' });
    const entries = store.list();
    expect(entries.map((e) => e.purpose)).toEqual(['second', 'first']);
    expect(entries[0]?.at).toBeGreaterThan(entries[1]?.at ?? Number.NaN);
  });

  it('persists through the injected storage and reloads in a fresh store', () => {
    const storage = new FakeStorage();
    const store = new LaunchHistoryStore({ storage, now: () => 42 });
    store.record(baseDraft);
    const reloaded = new LaunchHistoryStore({ storage });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.sessionId).toBe('ses_fake_1');
    expect(reloaded.list()[0]?.accountLabel).toBe('MAX_A');
  });

  it('notifies subscribers on record and clear', () => {
    const store = new LaunchHistoryStore({ now: () => 0 });
    const sizes: number[] = [];
    const unsubscribe = store.subscribe((entries) => sizes.push(entries.length));
    store.record(baseDraft);
    store.clear();
    unsubscribe();
    store.record(baseDraft);
    expect(sizes).toEqual([1, 0]);
  });
});

describe('LaunchHistoryStore (negative — [X2] discipline)', () => {
  it('refuses a non-placeholder account label at record time', () => {
    const store = new LaunchHistoryStore({ now: () => 0 });
    expect(() =>
      store.record({ ...baseDraft, accountLabel: 'someone' as never }),
    ).toThrow(/placeholder/);
  });

  it('masks identity-shaped free text before storing (email/12-digit/token)', () => {
    const store = new LaunchHistoryStore({ now: () => 0 });
    const entry = store.record({
      ...baseDraft,
      promptText: `mail ${emailish} about ${awsIdish} with ${tokenish}`,
      purpose: `purpose ${emailish}`,
      cwd: `/synthetic/${awsIdish}/workspace`,
    });
    expect(entry.promptPreview).not.toMatch(/@/);
    expect(entry.promptPreview).toContain(MASKED);
    expect(entry.purpose).toContain(MASKED);
    expect(entry.cwd).toContain(MASKED);
    // The testkit identity guard accepts everything the store renders.
    assertSynthesizedSafeText(JSON.stringify(store.list()));
  });

  it('drops persisted rows whose label is not one of the five placeholders', () => {
    const storage = new FakeStorage();
    const good = {
      at: 1,
      kind: 'prompt',
      accountLabel: 'MAX_B',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/x',
      purpose: 'ok row',
      promptPreview: 'p',
      outcome: 'accepted',
    };
    const tampered = { ...good, accountLabel: 'MAX_C' };
    storage.setItem(LAUNCH_HISTORY_STORAGE_KEY, JSON.stringify([tampered, good]));
    const store = new LaunchHistoryStore({ storage });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.accountLabel).toBe('MAX_B');
  });

  it('re-masks tampered persisted free text at load time', () => {
    const storage = new FakeStorage();
    storage.setItem(
      LAUNCH_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          at: 1,
          kind: 'prompt',
          accountLabel: 'ENT',
          backend: 'claude_code',
          substrate: 'sdk',
          cwd: '/synthetic/x',
          purpose: `contact ${emailish}`,
          promptPreview: `account ${awsIdish}`,
          outcome: 'failed',
        },
      ]),
    );
    const entry = new LaunchHistoryStore({ storage }).list()[0];
    expect(entry?.purpose).toContain(MASKED);
    expect(entry?.promptPreview).toContain(MASKED);
  });
});

describe('LaunchHistoryStore (edge)', () => {
  it('drops the oldest entry past the ring limit', () => {
    const store = new LaunchHistoryStore({ limit: 2, now: () => 0 });
    store.record({ ...baseDraft, purpose: 'one' });
    store.record({ ...baseDraft, purpose: 'two' });
    store.record({ ...baseDraft, purpose: 'three' });
    expect(store.list().map((e) => e.purpose)).toEqual(['three', 'two']);
  });

  it('defaults to the documented limit and refuses nonsense limits', () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(50);
    expect(() => new LaunchHistoryStore({ limit: 0 })).toThrow(RangeError);
    expect(() => new LaunchHistoryStore({ limit: 1.5 })).toThrow(RangeError);
  });

  it('resets to empty on corrupt persisted JSON (never throws)', () => {
    const storage = new FakeStorage();
    storage.setItem(LAUNCH_HISTORY_STORAGE_KEY, '{not json');
    expect(new LaunchHistoryStore({ storage }).list()).toEqual([]);
    storage.setItem(LAUNCH_HISTORY_STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    expect(new LaunchHistoryStore({ storage }).list()).toEqual([]);
    storage.setItem(LAUNCH_HISTORY_STORAGE_KEY, JSON.stringify([null, 5, 'x', []]));
    expect(new LaunchHistoryStore({ storage }).list()).toEqual([]);
  });

  it('truncates the prompt preview at the boundary', () => {
    const store = new LaunchHistoryStore({ now: () => 0 });
    const entry = store.record({
      ...baseDraft,
      promptText: 'a'.repeat(PROMPT_PREVIEW_CHARS + 1),
    });
    expect(entry.promptPreview).toHaveLength(PROMPT_PREVIEW_CHARS);
  });

  it('masking is idempotent and leaves clean text untouched', () => {
    const clean = 'synthesized text with no identity shapes';
    expect(maskIdentityShapedText(clean)).toBe(clean);
    const once = maskIdentityShapedText(`reach ${emailish} now`);
    expect(maskIdentityShapedText(once)).toBe(once);
  });
});
