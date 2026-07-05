/**
 * §9.3 SI↔FE #3 — DESIGN.md → theme build chain: an OFF-TOKEN style fails
 * `lint:tokens` BEFORE it can reach the app.
 *
 * The FE-1 token lint (app/scripts/lint-tokens.mjs) is the mechanical half of
 * DESIGN.md's FORBIDDEN list and the CI gate that stops off-token UI from
 * shipping. The per-department suite (app/src/chrome/theme/lint-tokens.spec.ts)
 * proves the linter's rules; THIS suite proves the SEAM: the SAME real linter,
 * run the way CI runs it, FAILS (exit 1) on a synthetic off-token file and
 * PASSES (exit 0) on an on-token one — so a DESIGN.md violation is caught at
 * the build gate, not in the running app.
 *
 * We assemble the REAL linter (node app/scripts/lint-tokens.mjs) against the
 * REAL generated allowlist (app/src/chrome/theme/tokens.css) + a temp scan
 * root; nothing is re-implemented.
 *
 * [X2]: synthetic fixture files under a temp dir; no identity.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const APP_DIR = join(REPO_ROOT, 'app');
const LINTER = join(APP_DIR, 'scripts/lint-tokens.mjs');
const ALLOWLIST = join(APP_DIR, 'src/chrome/theme/tokens.css');

let scanRoot: string;
afterEach(async () => {
  if (scanRoot) await rm(scanRoot, { recursive: true, force: true });
});

interface LintResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runLinter(root: string): Promise<LintResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [LINTER, '--root', root, '--allowlist', ALLOWLIST],
      { cwd: REPO_ROOT },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('SI↔FE #3 — DESIGN.md token lint gates off-token UI before the app', () => {
  it('the real linter PASSES on an on-token file (uses only theme variables)', async () => {
    scanRoot = await mkdtemp(join(tmpdir(), 'aibender-integ-token-ok-'));
    await writeFile(
      join(scanRoot, 'ok.tsx'),
      `export const Panel = () => (
  <div style={{ background: 'var(--ig-surface)', color: 'var(--ig-text)', borderRadius: '2px' }}>ok</div>
);
`,
      'utf8',
    );
    const result = await runLinter(scanRoot);
    expect(result.code, `linter should pass on-token; stdout:\n${result.stdout}`).toBe(0);
  });

  it('the real linter FAILS (exit 1) on an off-token hex color', async () => {
    scanRoot = await mkdtemp(join(tmpdir(), 'aibender-integ-token-hex-'));
    await writeFile(
      join(scanRoot, 'bad.tsx'),
      `export const Bad = () => <div style={{ background: '#ff00ff' }}>slop</div>;\n`,
      'utf8',
    );
    const result = await runLinter(scanRoot);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/off-token-hex|#ff00ff/i);
  });

  it('the real linter FAILS on a forbidden gradient (DESIGN.md FORBIDDEN list)', async () => {
    scanRoot = await mkdtemp(join(tmpdir(), 'aibender-integ-token-grad-'));
    await writeFile(
      join(scanRoot, 'grad.tsx'),
      `export const G = () => <div style={{ background: 'linear-gradient(#000, #fff)' }} />;\n`,
      'utf8',
    );
    const result = await runLinter(scanRoot);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/gradient/i);
  });

  it('the real linter FAILS on glassmorphism (backdrop-filter)', async () => {
    scanRoot = await mkdtemp(join(tmpdir(), 'aibender-integ-token-glass-'));
    await writeFile(
      join(scanRoot, 'glass.tsx'),
      `export const Glass = () => <div style={{ backdropFilter: 'blur(8px)' }} />;\n`,
      'utf8',
    );
    const result = await runLinter(scanRoot);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/glass|backdrop/i);
  });
});
