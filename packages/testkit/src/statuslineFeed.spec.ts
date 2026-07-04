/**
 * statuslineFeed suite (ICR-0010):
 *   positive — default payload is byte-compatible with the SI-3 bats fixture
 *              shape; tee writer lands `<label>.json` verbatim
 *   negative — identity-shaped free text refused; path-escaping label refused
 *   edge     — pinned mtime; `{}` rate limits; epoch resets_at passthrough
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { synthesizedStatuslinePayload, writeStatuslineTee } from './statuslineFeed.js';

describe('synthesizedStatuslinePayload', () => {
  it('defaults to the SI-3 bats fixture shape (both windows, fixture values)', () => {
    const parsed = JSON.parse(synthesizedStatuslinePayload()) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('synthetic-0001');
    expect(parsed['model']).toEqual({ id: 'claude-fixture', display_name: 'Fixture' });
    expect(parsed['cwd']).toBe('/tmp/fixture');
    expect(parsed['cost']).toEqual({ total_cost_usd: 0.0123 });
    expect(parsed['context_window']).toEqual({ used_percentage: 33.3 });
    expect(parsed['rate_limits']).toEqual({
      five_hour: { used_percentage: 41.5, resets_at: '2026-07-04T12:00:00Z' },
      seven_day: { used_percentage: 12, resets_at: '2026-07-08T00:00:00Z' },
    });
  });

  it('is deterministic for identical options', () => {
    expect(synthesizedStatuslinePayload()).toBe(synthesizedStatuslinePayload());
  });

  it('carries the 7d_sonnet window and epoch resets_at when asked (edge)', () => {
    const parsed = JSON.parse(
      synthesizedStatuslinePayload({
        rateLimits: { sevenDaySonnet: { usedPercentage: 8, resetsAt: 1_800_000_000 } },
      }),
    ) as { rate_limits: Record<string, unknown> };
    expect(parsed.rate_limits).toEqual({
      seven_day_sonnet: { used_percentage: 8, resets_at: 1_800_000_000 },
    });
  });

  it('produces the empty rate_limits edge with rateLimits: {}', () => {
    const parsed = JSON.parse(synthesizedStatuslinePayload({ rateLimits: {} })) as Record<
      string,
      unknown
    >;
    expect(parsed['rate_limits']).toEqual({});
  });

  it('REFUSES identity-shaped free text [X2 fixture policy] (negative)', () => {
    // Offending strings are runtime-built so no scanner-shaped literal is
    // ever committed to this public repo (the index.spec.ts convention).
    const emailish = ['fake-person', 'gmail.com'].join('@');
    const awsIdish = '123456'.repeat(2);
    expect(() => synthesizedStatuslinePayload({ sessionId: emailish })).toThrowError(/email/);
    expect(() => synthesizedStatuslinePayload({ cwd: `/home/${awsIdish}/x` })).toThrowError(
      /12-digit/,
    );
  });
});

describe('writeStatuslineTee', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aibender-testkit-tee-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tees the payload VERBATIM to <quotaDir>/<label>.json', () => {
    const payload = synthesizedStatuslinePayload();
    const path = writeStatuslineTee({ quotaDir: dir, label: 'MAX_A', payload });
    expect(path).toBe(join(dir, 'MAX_A.json'));
    expect(readFileSync(path, 'utf8')).toBe(payload);
  });

  it('pins the mtime when asked (capture-instant determinism) (edge)', () => {
    const path = writeStatuslineTee({ quotaDir: dir, label: 'ENT', mtimeMs: 1_700_000_000_000 });
    expect(Math.round(statSync(path).mtimeMs)).toBe(1_700_000_000_000);
  });

  it('creates the quota dir when missing and defaults the payload', () => {
    const nested = join(dir, 'quota');
    const path = writeStatuslineTee({ quotaDir: nested, label: 'MAX_B' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('rate_limits');
  });

  it('REFUSES path-escaping labels and identity-shaped labels (negative)', () => {
    expect(() => writeStatuslineTee({ quotaDir: dir, label: '../escape' })).toThrowError(
      /basename/,
    );
    const awsIdish = '123456'.repeat(2); // runtime-built, never committed
    expect(() => writeStatuslineTee({ quotaDir: dir, label: awsIdish })).toThrowError(
      /12-digit/,
    );
  });
});
