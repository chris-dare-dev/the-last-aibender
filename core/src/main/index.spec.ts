import { describe, expect, it, vi } from 'vitest';

import { DAEMON_NAME, main } from './index.js';

describe('aibender-core placeholder entry point', () => {
  // -- positive ------------------------------------------------------------

  it('prints exactly one line naming the daemon and returns exit code 0', () => {
    const lines: string[] = [];
    const code = main((line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(DAEMON_NAME);
    expect(DAEMON_NAME).toBe('aibender-core');
  });

  // -- negative ------------------------------------------------------------

  it('never touches console when a custom sink is provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      main(() => {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('did not run its direct-execution side effect under test import', () => {
    // Importing this module (as vitest just did) must not set an exit code.
    expect(process.exitCode ?? 0).toBe(0);
  });

  // -- edge ----------------------------------------------------------------

  it('is idempotent: repeated calls behave identically', () => {
    const first: string[] = [];
    const second: string[] = [];
    expect(main((l) => first.push(l))).toBe(0);
    expect(main((l) => second.push(l))).toBe(0);
    expect(second).toEqual(first);
  });
});
