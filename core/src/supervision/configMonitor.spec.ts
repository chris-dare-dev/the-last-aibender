/**
 * BE-9 ~/.claude.json size monitoring (plan §4/BE-9, blueprint §11):
 *   positive — a file over the warn threshold is flagged; under is not;
 *   negative — a missing file yields NO reading (never a fabricated 0 that
 *              reads as "healthy");
 *   edge     — the fixture paths are synthesized tmp dirs, NEVER the real
 *              ~/.claude dirs; the monitor reads size only, never contents [X2].
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CLAUDE_CONFIG_FILE,
  DEFAULT_CONFIG_WARN_BYTES,
  createClaudeConfigMonitor,
} from './configMonitor.js';

// Synthesized fixture config dirs — NEVER the real ~/.claude dirs [X2].
const roots: string[] = [];
function fixtureDir(bytes?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibender-cfg-'));
  roots.push(dir);
  if (bytes !== undefined) {
    // A synthetic .claude.json of the requested byte size (content is filler —
    // the monitor reads SIZE only, never these bytes).
    writeFileSync(join(dir, CLAUDE_CONFIG_FILE), 'x'.repeat(bytes));
  }
  return dir;
}

afterAll(() => {
  // tmp dirs are OS-reaped; nothing persisted into the repo.
});

describe('BE-9 ~/.claude.json size monitor', () => {
  it('flags a config over the warn threshold, passes one under (positive)', () => {
    const big = fixtureDir(64); // over our tiny test threshold
    const small = fixtureDir(4); // under
    const monitor = createClaudeConfigMonitor({
      configDirsByAccount: { MAX_A: big, MAX_B: small },
      warnBytes: 16,
    });
    const sample = monitor.sample();
    const byAccount = new Map(sample.map((s) => [s.account, s]));
    expect(byAccount.get('MAX_A')?.overWarn).toBe(true);
    expect(byAccount.get('MAX_A')?.bytes).toBe(64);
    expect(byAccount.get('MAX_B')?.overWarn).toBe(false);
    expect(monitor.overWarn()).toEqual(['MAX_A']);
  });

  it('a missing file yields NO reading, never a fabricated 0 (negative)', () => {
    const empty = fixtureDir(); // dir exists but no .claude.json
    const monitor = createClaudeConfigMonitor({ configDirsByAccount: { ENT: empty } });
    const [reading] = monitor.sample();
    expect(reading?.bytes).toBeUndefined();
    expect(reading?.overWarn).toBe(false);
    expect(monitor.overWarn()).toEqual([]);
  });

  it('the default warn threshold is 10 MB (blueprint-aligned config)', () => {
    expect(DEFAULT_CONFIG_WARN_BYTES).toBe(10 * 1024 * 1024);
  });

  it('never throws on an unreadable dir (edge)', () => {
    const monitor = createClaudeConfigMonitor({
      configDirsByAccount: { MAX_A: '/nonexistent/path/that/does/not/exist' },
    });
    expect(() => monitor.sample()).not.toThrow();
    expect(monitor.sample()[0]?.bytes).toBeUndefined();
  });
});
