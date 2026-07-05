/**
 * FE account-registry seam ([X1] scalability; ICR-0013).
 *
 * Positive: seed default (3 Claude + 2 backends); N-Claude registries (3/4/5);
 *           backend derived via the frozen pairing; hues are tokens only.
 * Negative: non-form inputs (email/name/HACKER/MAX_AB/lowercase) DROPPED
 *           fail-closed — a raw identifier can NEVER become an entry [X2].
 * Edge: dedup + order stability; empty input → backends-only; module-level
 *       injection resets to seed on empty.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  SEED_CLAUDE_ACCOUNTS,
  accountConfigStore,
  accountRegistry,
  buildAccountRegistry,
  currentAccountConfigSource,
  currentConfiguredClaudeAccounts,
  normalizeClaudeAccounts,
  setConfiguredClaudeAccounts,
} from './accountRegistry.ts';

const BACKEND_LABELS = ['AWS_DEV', 'LOCAL'] as const;

/** Identity-shaped adversarial inputs, runtime-built (no committed literal). */
const emailish = ['owner.real', 'example.com'].join('@');
const awsIdish = '987654'.repeat(2);

afterEach(() => {
  // Restore the module-level configured set so tests never bleed.
  setConfiguredClaudeAccounts(SEED_CLAUDE_ACCOUNTS);
});

describe('normalizeClaudeAccounts (fail-closed [X2])', () => {
  it('keeps only sanctioned Claude forms, first-seen order, deduped', () => {
    expect(normalizeClaudeAccounts(['MAX_A', 'MAX_B', 'MAX_A', 'ENT'])).toEqual([
      'MAX_A',
      'MAX_B',
      'ENT',
    ]);
  });

  it('drops every non-form input (identity, HACKER, MAX_AB, lowercase)', () => {
    const dirty = [
      emailish,
      awsIdish,
      'HACKER',
      'MAX_AB',
      'max_c',
      'AWS_DEV', // a backend label is NOT a Claude account
      'LOCAL',
      'REAL_NAME',
      42,
      null,
      undefined,
      { label: 'MAX_C' },
    ];
    expect(normalizeClaudeAccounts(dirty)).toEqual([]);
  });

  it('admits MAX_C / MAX_D by FORM without any code change', () => {
    expect(normalizeClaudeAccounts(['MAX_C', 'MAX_D'])).toEqual(['MAX_C', 'MAX_D']);
  });
});

describe('buildAccountRegistry (positive)', () => {
  it('the seed three yields 3 Claude accounts + 2 backends in order', () => {
    const reg = buildAccountRegistry(SEED_CLAUDE_ACCOUNTS);
    expect(reg.claudeAccounts.map((e) => e.label)).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    expect(reg.backends.map((e) => e.label)).toEqual([...BACKEND_LABELS]);
    expect(reg.entries.map((e) => e.label)).toEqual([
      'MAX_A',
      'MAX_B',
      'ENT',
      'AWS_DEV',
      'LOCAL',
    ]);
    expect(reg.entries.map((e) => e.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([
    ['3-Claude', ['MAX_A', 'MAX_B', 'ENT'], 5],
    ['4-Claude', ['MAX_A', 'MAX_B', 'ENT', 'MAX_C'], 6],
    ['5-Claude', ['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D'], 7],
  ])('%s registry: N Claude + always 2 backends, contiguous slots', (_n, claude, total) => {
    const reg = buildAccountRegistry(claude);
    expect(reg.claudeAccounts).toHaveLength(claude.length);
    expect(reg.backends).toHaveLength(2);
    expect(reg.entries).toHaveLength(total);
    expect(reg.entries.map((e) => e.slot)).toEqual(
      Array.from({ length: total }, (_v, i) => i + 1),
    );
    // Backends are always the tail two, in fixed order + fixed hues.
    expect(reg.backends.map((e) => e.label)).toEqual([...BACKEND_LABELS]);
    expect(reg.backends.map((e) => e.channelTokenVar)).toEqual([
      'var(--ig-channel-bedrock)',
      'var(--ig-channel-lmstudio)',
    ]);
  });

  it('derives the backend from the frozen pairing for every entry', () => {
    const reg = buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
    for (const entry of reg.claudeAccounts) expect(entry.backend).toBe('claude_code');
    expect(reg.backends.map((e) => e.backend)).toEqual(['opencode', 'lmstudio']);
  });

  it('every channelTokenVar is a channel-hue TOKEN (never a raw color)', () => {
    const reg = buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
    for (const entry of reg.entries) {
      expect(entry.channelTokenVar).toMatch(/^var\(--ig-channel-[a-z-]+\)$/);
    }
  });

  it('a 4th/5th Claude account reuses the fixed Claude-hue palette by position', () => {
    const reg = buildAccountRegistry(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
    const claudeHues = reg.claudeAccounts.map((e) => e.channelTokenVar);
    // slot 4 (MAX_C) reuses slot-1 hue; slot 5 (MAX_D) reuses slot-2 hue.
    expect(claudeHues[3]).toBe(claudeHues[0]);
    expect(claudeHues[4]).toBe(claudeHues[1]);
  });

  it('returns frozen data — entries cannot be mutated into other labels', () => {
    const reg = buildAccountRegistry(['MAX_A']);
    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen(reg.entries)).toBe(true);
    expect(Object.isFrozen(reg.entries[0])).toBe(true);
  });
});

describe('buildAccountRegistry (negative / edge, fail-closed)', () => {
  it('all-garbage input yields ONLY the two backends (never a raw identifier)', () => {
    const reg = buildAccountRegistry([emailish, awsIdish, 'HACKER', 'REAL_NAME']);
    expect(reg.claudeAccounts).toEqual([]);
    expect(reg.entries.map((e) => e.label)).toEqual([...BACKEND_LABELS]);
    for (const entry of reg.entries) {
      expect(entry.label).not.toContain('@');
      expect(entry.label).not.toMatch(/\d{6}/);
    }
  });

  it('empty input yields ONLY the two backends', () => {
    const reg = buildAccountRegistry([]);
    expect(reg.entries.map((e) => e.label)).toEqual([...BACKEND_LABELS]);
  });
});

describe('module-level configured set (composition-root injection)', () => {
  it('defaults to the seed three', () => {
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    expect(accountRegistry().claudeAccounts.map((e) => e.label)).toEqual([
      'MAX_A',
      'MAX_B',
      'ENT',
    ]);
  });

  it('injecting a 5-Claude set is reflected by accountRegistry()', () => {
    setConfiguredClaudeAccounts(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
    expect(accountRegistry().claudeAccounts.map((e) => e.label)).toEqual([
      'MAX_A',
      'MAX_B',
      'ENT',
      'MAX_C',
      'MAX_D',
    ]);
  });

  it('injecting an all-garbage set falls back to the seed three (never empty-claude)', () => {
    setConfiguredClaudeAccounts([emailish, 'HACKER']);
    expect(currentConfiguredClaudeAccounts()).toEqual([...SEED_CLAUDE_ACCOUNTS]);
  });
});

describe('FE-1 reactive config store + source provenance', () => {
  it('is a subscribable store — a set() notifies subscribers with the new value', () => {
    const seen: (readonly string[])[] = [];
    const off = accountConfigStore.subscribe((s) => seen.push(s.configured));
    setConfiguredClaudeAccounts(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);
    off();
    expect(seen.at(-1)).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);
  });

  it('records provenance: bootstrap on a real set, seed on empty/garbage fallback', () => {
    setConfiguredClaudeAccounts(['MAX_A', 'MAX_C'], 'bootstrap');
    expect(currentAccountConfigSource()).toBe('bootstrap');
    // A dev-shim set records the shim provenance.
    setConfiguredClaudeAccounts(['MAX_A'], 'shim');
    expect(currentAccountConfigSource()).toBe('shim');
    // An empty/all-garbage set forces the seed source regardless of the arg.
    setConfiguredClaudeAccounts([emailish, 'HACKER'], 'bootstrap');
    expect(currentAccountConfigSource()).toBe('seed');
    expect(currentConfiguredClaudeAccounts()).toEqual([...SEED_CLAUDE_ACCOUNTS]);
  });
});
