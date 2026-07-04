/**
 * FE-1 token-lint tests (plan §9.2 FE-1 row).
 *
 *  positive — on-token styles pass the lint.
 *  negative — the three seeded violation classes (off-token hex color,
 *             oversized radius, box-shadow) each FAIL, plus the bonus
 *             mechanical rules (gradient, glass, font, easing, loader) and
 *             the drop-shadow() filter-function form.
 *  edge     — the theme directory itself is exempt (and ONLY the exact
 *             top-level chrome/theme/ path — look-alike directories are NOT);
 *             a missing allowlist is a configuration error (exit 2), not a
 *             silent pass.
 *
 * The lint script is spawned exactly as CI runs it (plain `node`).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const LINT = fileURLToPath(new URL('../../../scripts/lint-tokens.mjs', import.meta.url));

interface LintResult {
  status: number | null;
  out: string;
}

function runLint(root: string, extraArgs: string[] = []): LintResult {
  const res = spawnSync(process.execPath, [LINT, '--root', root, ...extraArgs], {
    encoding: 'utf8',
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

const tempDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ig-lint-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Positive — on-token styles pass
// ---------------------------------------------------------------------------

describe('lint positive', () => {
  it('passes a file that styles exclusively with tokens', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'panel.css'),
      [
        '.panel {',
        '  background: var(--ig-surface-panel);',
        '  color: var(--ig-ink-primary);',
        '  border-top: var(--ig-line-width) solid var(--ig-line-hairline);',
        '  border-radius: var(--ig-radius-2);',
        '  box-shadow: none;',
        '  font-family: var(--ig-font-mono);',
        '  transition: opacity var(--ig-motion-fast) var(--ig-ease-mechanical);',
        '}',
        '.readout { color: #FFB000; border-radius: 2px; }',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'Panel.tsx'),
      [
        `export const Panel = () => (`,
        `  <div className="bg-surface-panel text-ink rounded-2 font-mono ease-mechanical" />`,
        `);`,
      ].join('\n'),
    );
    const { status, out } = runLint(root);
    expect(out).toContain('token-lint: OK');
    expect(status).toBe(0);
  });

  it('passes the real app/src tree (the shipped tree is clean)', () => {
    const appSrc = fileURLToPath(new URL('../../../src', import.meta.url));
    const { status, out } = runLint(appSrc);
    expect(out).toContain('token-lint: OK');
    expect(status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative — seeded violations fail (the plan's three classes + bonus rules)
// ---------------------------------------------------------------------------

describe('lint negative', () => {
  it('fails on the three seeded violation classes: off-token hex, radius, shadow', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'slop.css'),
      [
        '.slop {',
        '  color: #7C3AED;', // violation 1: off-token hex (indigo, of course)
        '  border-radius: 12px;', // violation 2: radius beyond 0–2px
        '  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);', // violation 3: a shadow
        '}',
      ].join('\n'),
    );
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('off-token-hex');
    expect(out).toContain('#7C3AED');
    expect(out).toContain('radius');
    expect(out).toContain('12px');
    expect(out).toContain('shadow');
    expect(out).toContain('token-lint: FAIL');
  });

  it('fails on Tailwind-shaped slop: bg-indigo-500 is not a token, rounded-2xl, shadow-xl', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'Slop.tsx'),
      [
        `export const Slop = () => (`,
        `  <div className="rounded-2xl shadow-xl bg-gradient-to-r backdrop-blur-md" style={{ background: '#6366F1' }} />`,
        `);`,
      ].join('\n'),
    );
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('radius');
    expect(out).toContain('rounded-2xl');
    expect(out).toContain('shadow-xl');
    expect(out).toContain('gradient');
    expect(out).toContain('glass');
    expect(out).toContain('off-token-hex');
  });

  it('fails on forbidden faces, spring easing, sparkles, and skeleton loaders', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'more-slop.tsx'),
      [
        `import { Sparkles } from 'lucide-react';`,
        `const style = { fontFamily: '"Inter", sans-serif' };`,
        `const anim = { type: 'spring', ease: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)' };`,
        `const loader = 'animate-pulse';`,
        `export default { style, anim, loader, Sparkles };`,
      ].join('\n'),
    );
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('font-family');
    expect(out).toContain('easing');
    expect(out).toContain('iconography');
    expect(out).toContain('loader');
  });

  it('fails on the drop-shadow() filter function — token-colored glows included', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'glow.css'),
      // The halo token is sanctioned via color/opacity/outline ONLY (§2.3);
      // routing it through a filter is still a forbidden colored glow (§7#4).
      '.halo { filter: drop-shadow(0 0 8px var(--ig-accent-halo)); }',
    );
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('shadow');
    expect(out).toContain('drop-shadow()');
  });

  it('reports file and line for every violation', () => {
    const root = scratch();
    writeFileSync(join(root, 'one.css'), 'a { color: #123456; }');
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toMatch(/one\.css:1/);
  });
});

// ---------------------------------------------------------------------------
// Edge — exemptions and configuration failure modes
// ---------------------------------------------------------------------------

describe('lint edge cases', () => {
  it('exempts the theme directory itself (where values are DEFINED)', () => {
    const root = scratch();
    mkdirSync(join(root, 'chrome', 'theme', 'nested'), { recursive: true });
    // Off-token hex inside chrome/theme/ (any depth) must NOT fail the lint.
    writeFileSync(join(root, 'chrome', 'theme', 'draft-tokens.css'), 'a { color: #ABCDEF; }');
    writeFileSync(join(root, 'chrome', 'theme', 'nested', 'more.css'), 'b { color: #FEDCBA; }');
    const { status, out } = runLint(root);
    expect(out).toContain('token-lint: OK');
    expect(status).toBe(0);
  });

  it('does NOT exempt look-alike paths: features/chrome/theme/ still fails', () => {
    const root = scratch();
    mkdirSync(join(root, 'features', 'chrome', 'theme'), { recursive: true });
    // A substring exemption would let agents evade the lint by directory
    // naming (DESIGN.md §8.3 scopes it to exactly chrome/theme/ at the root).
    writeFileSync(join(root, 'features', 'chrome', 'theme', 'evade.css'), 'a { color: #ABCDEF; }');
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('off-token-hex');
    expect(out).toContain('#ABCDEF');
  });

  it('does NOT exempt look-alike paths: chrome/themed/ still fails', () => {
    const root = scratch();
    mkdirSync(join(root, 'chrome', 'themed'), { recursive: true });
    writeFileSync(join(root, 'chrome', 'themed', 'evade.css'), 'a { color: #ABCDEF; }');
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('off-token-hex');
    expect(out).toContain('#ABCDEF');
  });

  it('fails CLOSED with exit 2 when the tokens.css allowlist is missing', () => {
    const root = scratch();
    writeFileSync(join(root, 'fine.css'), 'a { color: var(--ig-ink-primary); }');
    const { status, out } = runLint(root, ['--allowlist', join(root, 'nope', 'tokens.css')]);
    expect(status).toBe(2);
    expect(out).toContain('allowlist not found');
    expect(out).toContain('build:tokens');
  });

  it('fails with exit 2 on a missing scan root (misconfiguration is loud)', () => {
    const { status, out } = runLint(join(scratch(), 'does-not-exist'));
    expect(status).toBe(2);
    expect(out).toContain('scan root not found');
  });

  it('honors the token-lint-allow escape hatch on that line only', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'escape.css'),
      [
        'a { color: #123456; } /* token-lint-allow — ADR-XXXX */',
        'b { color: #654321; }',
      ].join('\n'),
    );
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('#654321');
    expect(out).not.toContain('#123456');
  });

  it('short 3-digit hexes are normalized before allowlist comparison', () => {
    const root = scratch();
    // #fb0 expands to #ffbb00 which is NOT the amber token #ffb000 → violation.
    writeFileSync(join(root, 'short.css'), 'a { color: #fb0; }');
    const { status, out } = runLint(root);
    expect(status).toBe(1);
    expect(out).toContain('off-token-hex');
  });
});
