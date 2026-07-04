/**
 * FE-1 theme tests (plan §9.2 FE-1 row).
 *
 *  positive — tokens compile to the Tailwind theme (real tailwindcss 4 compile;
 *             slop utilities provably generate nothing) and the committed
 *             generated CSS matches the renderers (drift guard).
 *  edge     — the reduced-motion mapping is TOTAL: every animated token has a
 *             static variant in tokens.ts AND is remapped in the generated CSS.
 *  (negative — off-token lint failures live in lint-tokens.spec.ts.)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from 'tailwindcss';

import { renderTailwindTheme, renderTokensCss } from './generate.ts';
import {
  allHexValues,
  animatedTokens,
  channelOrder,
  channels,
  motion,
  tokens,
} from './tokens.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const kebab = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

// ---------------------------------------------------------------------------
// Positive — token compile chain
// ---------------------------------------------------------------------------

describe('token source of truth', () => {
  it('locks the Instrument Grade core values', () => {
    expect(tokens.surface.base).toBe('#111110');
    expect(tokens.surface.panel).toBe('#1A1917');
    expect(tokens.surface.raised).toBe('#242220');
    expect(tokens.ink.primary).toBe('#E8E6E1');
    expect(tokens.accent.amber).toBe('#FFB000');
    expect(tokens.status.ok).toBe('#3FB950');
    expect(tokens.status.degraded).toBe('#D29922');
    expect(tokens.status.fault).toBe('#F85149');
  });

  it('exposes exactly the five channels in fixed slot order', () => {
    expect(channelOrder).toEqual(['MAX_A', 'MAX_B', 'ENT', 'BEDROCK', 'LMSTUDIO']);
    const slots = Object.values(channels).map((c) => c.slot);
    expect([...slots].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps radii within 0–2px', () => {
    for (const value of Object.values(tokens.radius)) {
      expect(parseFloat(value)).toBeLessThanOrEqual(2);
    }
  });

  it('keeps mechanical motion within the 120–180ms band', () => {
    const { fastMs, baseMs, deliberateMs } = motion.duration;
    for (const d of [fastMs, baseMs, deliberateMs]) {
      expect(d).toBeGreaterThanOrEqual(120);
      expect(d).toBeLessThanOrEqual(180);
    }
  });

  it('reserves exactly ONE ceremonial animation (workstream lineage)', () => {
    const ceremonial = Object.entries(animatedTokens).filter(
      ([, spec]) => spec.ceremonial === true,
    );
    expect(ceremonial.map(([name]) => name)).toEqual(['ceremony-lineage']);
  });
});

describe('generated CSS artifacts (committed) match the renderers — no drift', () => {
  it('tokens.css is exactly renderTokensCss()', () => {
    expect(read('./tokens.css')).toBe(renderTokensCss());
  });

  it('tailwind.theme.css is exactly renderTailwindTheme()', () => {
    expect(read('./tailwind.theme.css')).toBe(renderTailwindTheme());
  });

  it('tokens.css carries the core custom properties', () => {
    const css = renderTokensCss();
    expect(css).toContain('--ig-surface-base: #111110;');
    expect(css).toContain('--ig-ink-primary: #E8E6E1;');
    expect(css).toContain('--ig-accent: #FFB000;');
    expect(css).toContain('--ig-channel-max-a: #8FB0C9;');
    expect(css).toContain('--ig-radius-2: 2px;');
    expect(css).toContain('--ig-shadow: none;');
    expect(css).toContain('--ig-latency-interaction: 100ms;');
    expect(css).toContain('--ig-palette-width: 640px;');
  });
});

describe('Tailwind 4 theme consumes ONLY the tokens', () => {
  const theme = renderTailwindTheme();

  it('erases the default slop-bearing namespaces first', () => {
    for (const ns of ['--color-*', '--radius-*', '--shadow-*', '--blur-*', '--ease-*', '--animate-*']) {
      expect(theme).toContain(`${ns}: initial;`);
    }
    // resets must precede definitions
    expect(theme.indexOf('--color-*: initial;')).toBeLessThan(
      theme.indexOf('--color-surface-base:'),
    );
  });

  it('contains no color literal that is not an Instrument Grade token', () => {
    const tokenHexes = new Set(allHexValues());
    for (const m of theme.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      expect(tokenHexes.has(m[0].toLowerCase())).toBe(true);
    }
  });

  it('compiles: on-token utilities generate, slop utilities generate NOTHING', async () => {
    const compiled = await compile(`${theme}\n@tailwind utilities;\n`, {
      base: fileURLToPath(new URL('.', import.meta.url)),
    });
    const css = compiled.build([
      // on-token
      'bg-surface-base',
      'text-accent',
      'rounded-2',
      'font-mono',
      'border-line-hairline',
      'ease-mechanical',
      // slop — must not exist (theme-driven utilities die with the resets;
      // static utilities like bg-gradient-to-r are the lint's job instead)
      'bg-indigo-500',
      'bg-white',
      'shadow-xl',
      'rounded-3xl',
      'backdrop-blur-md',
    ]);

    expect(css).toContain('.bg-surface-base');
    expect(css).toContain('background-color: var(--color-surface-base)');
    expect(css).toContain('.text-accent');
    expect(css).toContain('.rounded-2');
    expect(css).toContain('.font-mono');
    expect(css).toContain('.ease-mechanical');

    for (const slop of [
      'indigo',
      'bg-white',
      'shadow-xl',
      'rounded-3xl',
      'backdrop-blur',
    ]) {
      expect(css).not.toContain(slop);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge — reduced-motion mapping is total
// ---------------------------------------------------------------------------

describe('reduced-motion mapping is total over every animated token', () => {
  const animatedNames = Object.keys(motion.animated);

  it('covers a non-trivial set of animated tokens', () => {
    expect(animatedNames.length).toBeGreaterThanOrEqual(5);
  });

  it('every animated token declares a static variant in tokens.ts', () => {
    for (const [name, spec] of Object.entries(motion.animated)) {
      expect(['instant', 'discrete'], `${name} mode`).toContain(spec.reducedMotion.mode);
      expect(spec.reducedMotion.spec.length, `${name} spec text`).toBeGreaterThan(10);
    }
  });

  it('the generated CSS remaps EVERY animated token under prefers-reduced-motion', () => {
    const css = renderTokensCss();
    const reduceBlock = css.split('@media (prefers-reduced-motion: reduce)')[1];
    expect(reduceBlock, 'reduced-motion block exists').toBeTruthy();
    for (const name of animatedNames) {
      expect(reduceBlock).toContain(`--ig-motion-${kebab(name)}-duration: 0ms;`);
    }
  });

  it('every animated token also emits its normal duration/ease custom props', () => {
    const css = renderTokensCss();
    for (const [name, spec] of Object.entries(motion.animated)) {
      expect(css).toContain(`--ig-motion-${kebab(name)}-duration: ${spec.durationMs}ms;`);
      expect(css).toContain(`--ig-motion-${kebab(name)}-ease: ${spec.easing};`);
    }
  });
});

// ---------------------------------------------------------------------------
// DESIGN.md ↔ tokens.ts lock-step (the lock document is normative)
// ---------------------------------------------------------------------------

describe('DESIGN.md mirrors the token values (lock-step guard)', () => {
  const design = read('../../../../DESIGN.md');

  it('contains every core hex the system defines', () => {
    for (const hex of [
      tokens.surface.base,
      tokens.surface.panel,
      tokens.surface.raised,
      tokens.ink.primary,
      tokens.ink.muted,
      tokens.accent.amber,
      tokens.status.ok,
      tokens.status.degraded,
      tokens.status.fault,
      ...Object.values(channels).map((c) => c.indexHue),
    ]) {
      expect(design).toContain(hex);
    }
  });

  it('locks the motion grammar values', () => {
    expect(design).toContain('cubic-bezier(0.2, 0, 0, 1)');
    expect(design).toContain('cubic-bezier(0.19, 1, 0.22, 1)');
    for (const d of ['120ms', '150ms', '180ms', '320ms', '640ms', '480ms', '1200ms']) {
      expect(design).toContain(d);
    }
  });

  it('names the five channels and the FORBIDDEN list', () => {
    for (const id of channelOrder) expect(design).toContain(`\`${id}\``);
    expect(design).toContain('## 7. FORBIDDEN');
    expect(design).toContain('Glassmorphism');
  });
});
