/**
 * ARCHITECTURAL TEST (BE-8; rule 3, findings §R4): a saved dynamic-workflow
 * script is scanned STATICALLY (meta only) and NEVER EXECUTED. This test reads
 * the scanner + workflowMeta source and asserts there is NO execution path —
 * no `eval`, `new Function`, `import()`, `require`, `node:vm`, or
 * `node:child_process`. A future edit that reaches for any of those trips this
 * test loudly (the same discipline as the BE-2 "no PTY parser imports" and
 * BE-7 "no native-store write path" arch tests, plan §9.2).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseWorkflowMeta } from './workflowMeta.js';

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\beval\s*\(/, why: 'eval() would execute workflow-script source' },
  { pattern: /new\s+Function\s*\(/, why: 'new Function() would execute workflow-script source' },
  { pattern: /\bimport\s*\(/, why: 'dynamic import() would load a workflow script as a module' },
  { pattern: /\brequire\s*\(/, why: 'require() would load a workflow script as a module' },
  { pattern: /node:vm|['"]vm['"]/, why: 'node:vm would execute workflow-script source' },
  {
    pattern: /node:child_process|['"]child_process['"]/,
    why: 'child_process would spawn/execute',
  },
];

const CATALOG_SOURCES = [
  '../catalog/scanner.ts',
  '../catalog/workflowMeta.ts',
  '../catalog/frontmatter.ts',
];

/** Read a source file and STRIP comments — the scan checks executable code,
 *  not the module's own prose describing what it must never do. */
function readCodeOnly(rel: string): string {
  const path = fileURLToPath(new URL(rel, import.meta.url));
  const raw = readFileSync(path, 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (not `://` in URLs)
}

describe('catalog — workflow scripts are NEVER executed (architectural test)', () => {
  for (const rel of CATALOG_SOURCES) {
    it(`${rel} contains no code-execution primitive`, () => {
      const source = readCodeOnly(rel);
      for (const { pattern, why } of FORBIDDEN) {
        expect(pattern.test(source), `${rel}: ${why}`).toBe(false);
      }
    });
  }

  it('workflowMeta returns meta from source text, never a live object', () => {
    // A regression guard: the parser output shape is a plain data record with
    // primitive fields only — it can never carry a function the caller might
    // invoke.
    const result = parseWorkflowMeta(
      "export const meta = { name: 'x', description: 'y' }; globalThis.__PWNED = true;",
    );
    expect(result.ok).toBe(true);
    // The side-effect statement after the meta was NOT executed.
    expect((globalThis as Record<string, unknown>)['__PWNED']).toBeUndefined();
  });
});
