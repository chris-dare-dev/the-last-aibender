/**
 * [X4] ARCHITECTURAL TESTS (plan §9.2 BE-7 negative row: "native-store write
 * path absent (architectural test)"):
 *
 *   1. NO WRITE PATH: no module in core/src/workstreams/ imports a
 *      write-capable fs API — the reconciler/automation/engine read
 *      transcripts and watch trees through read-only surfaces only, and the
 *      opencode.db access goes through BE-4's read-only guarded handle.
 *   2. NO NATIVE IDS ON THE WIRE [X2]: wire.ts never projects
 *      native_session_id / native_scope into a wire record.
 *
 * Source-level scans (the BE-2 "no parser imports" precedent): the fs-audit
 * in reconciler.spec.ts proves the runtime half.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

const MODULE_FILES = readdirSync(HERE).filter(
  (entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'),
);

/**
 * Write-capable node:fs (and fs/promises) surface — none may appear. Names
 * are the fs API identifiers themselves (generic verbs like `rename(` are
 * legitimate domain methods — the import-allowlist test below is the strict
 * gate; this list catches qualified `fs.` usage and the Sync family).
 */
const FORBIDDEN_FS_TOKENS = [
  'writeFileSync',
  'writeFile(',
  'appendFileSync',
  'appendFile(',
  'createWriteStream',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'renameSync',
  'mkdirSync',
  'truncateSync',
  'chmodSync',
  'chownSync',
  'copyFileSync',
  'openSync',
  'fs/promises',
];

describe('[X4] no write path to native stores (source scan)', () => {
  it('lists the expected module set (a new module joins this audit automatically)', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(10);
    expect(MODULE_FILES).toContain('reconciler.ts');
    expect(MODULE_FILES).toContain('automation.ts');
  });

  for (const file of MODULE_FILES) {
    it(`${file} imports no write-capable fs API`, () => {
      const source = readFileSync(join(HERE, file), 'utf8');
      for (const token of FORBIDDEN_FS_TOKENS) {
        expect(source, `${file} must not reference ${token}`).not.toContain(token);
      }
    });
  }

  it('the fs surface actually imported is read-only (readFileSync/readdirSync/statSync/watch)', () => {
    for (const file of MODULE_FILES) {
      const source = readFileSync(join(HERE, file), 'utf8');
      const fsImport = /import\s+\{([^}]*)\}\s+from\s+'node:fs'/.exec(source);
      if (fsImport === null) continue;
      const imported = (fsImport[1] ?? '')
        .split(',')
        .map((token) => token.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '')
        .filter((token) => token.length > 0);
      for (const name of imported) {
        expect(
          ['readFileSync', 'readdirSync', 'statSync', 'watch', 'FSWatcher'],
          `${file} imports non-read-only fs member ${name}`,
        ).toContain(name);
      }
    }
  });

  it('opencode.db access flows ONLY through the read-only guarded SELECT surface', () => {
    const source = readFileSync(join(HERE, 'reconciler.ts'), 'utf8');
    expect(source).not.toContain('DatabaseSync'); // never a direct sqlite handle
    expect(source).toContain('select(');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
  });
});

describe('[X2] native ids never reach the wire projections', () => {
  it('wire.ts never reads native_session_id / nativeSessionId / nativeScope', () => {
    const source = readFileSync(join(HERE, 'wire.ts'), 'utf8');
    // The module doc names the rule; assert no CODE line touches the fields.
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    for (const line of codeLines) {
      expect(line).not.toContain('nativeSessionId');
      expect(line).not.toContain('native_session_id');
      expect(line).not.toContain('nativeScope');
    }
  });
});
