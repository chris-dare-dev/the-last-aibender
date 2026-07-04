import { describe, expect, it } from 'vitest';

import { findServeProcesses, matchesOpencodeServeArgv } from './argv.js';

describe('serve argv matching (blueprint §4.2: argv `serve`, never process name)', () => {
  // -- positive -------------------------------------------------------------

  it('matches a real serve invocation, absolute path or bare name', () => {
    expect(
      matchesOpencodeServeArgv([
        '/synthetic/home/.opencode/bin/opencode',
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '39271',
      ]),
    ).toBe(true);
    expect(matchesOpencodeServeArgv(['opencode', 'serve'])).toBe(true);
  });

  it('tolerates flags BEFORE the serve subcommand', () => {
    expect(matchesOpencodeServeArgv(['opencode', '--print-logs', 'serve'])).toBe(true);
  });

  // -- negative (plan §9.2: desktop-app process never matched) ----------------

  it('never matches the desktop app or its helpers', () => {
    expect(
      matchesOpencodeServeArgv(['/Applications/OpenCode.app/Contents/MacOS/OpenCode']),
    ).toBe(false);
    expect(
      matchesOpencodeServeArgv([
        '/Applications/OpenCode.app/Contents/Frameworks/OpenCode Helper (Renderer).app/Contents/MacOS/OpenCode Helper (Renderer)',
        '--type=renderer',
      ]),
    ).toBe(false);
  });

  it('never matches other opencode subcommands or name lookalikes', () => {
    expect(matchesOpencodeServeArgv(['opencode', 'run', 'serve'])).toBe(false);
    expect(matchesOpencodeServeArgv(['opencode'])).toBe(false);
    expect(matchesOpencodeServeArgv(['opencode-serve-lookalike', 'serve'])).toBe(false);
    expect(matchesOpencodeServeArgv(['node', 'opencode', 'serve'])).toBe(false);
    expect(matchesOpencodeServeArgv([])).toBe(false);
  });

  // -- edge -------------------------------------------------------------------

  it('filters a mixed process table down to genuine serve children', () => {
    const rows = [
      { pid: 100, argv: ['/synthetic/bin/opencode', 'serve', '--port', '1234'] },
      { pid: 101, argv: ['/Applications/OpenCode.app/Contents/MacOS/OpenCode'] },
      { pid: 102, argv: ['opencode', 'tui'] },
    ];
    expect(findServeProcesses(rows).map((row) => row.pid)).toEqual([100]);
  });
});
