#!/usr/bin/env node
/**
 * FE-1 token lint — the mechanical half of DESIGN.md's FORBIDDEN list.
 * Run: `pnpm -F aibender-app lint:tokens`   (plain Node, zero dependencies)
 *
 * Scans everything under app/src (excluding the token source itself at
 * app/src/chrome/theme/) and FAILS on off-token styling:
 *
 *   off-token-hex   hex colors not defined in tokens.ts
 *   color-fn        rgb()/hsl()/oklch() literals not defined in tokens.ts
 *   radius          border-radius > 2px, rounded-md/lg/…/full utilities
 *   shadow          any box-shadow/text-shadow/drop-shadow other than none,
 *                   including the CSS filter-function form drop-shadow(...)
 *   gradient        linear/radial/conic gradients, bg-gradient-* utilities
 *   glass           backdrop-filter / backdrop-blur (glassmorphism)
 *   font-family     literal font stacks (must use var(--ig-font-*)) and the
 *                   forbidden faces Inter/Geist/Space Grotesk/Roboto
 *   easing          spring()/type:"spring", off-token cubic-bezier() literals
 *   iconography     sparkles/wand/robot/brain/zap glyphs or sparkle icon imports
 *   loader          skeleton shimmer / animate-pulse loaders
 *
 * Allowed values are read from the GENERATED app/src/chrome/theme/tokens.css
 * (build first: `pnpm -F app build:tokens`).
 *
 * Escape hatch: a line containing `token-lint-allow` is skipped. Using it
 * requires FE-ORCH sign-off recorded in an ADR (DESIGN.md §8.4). No other
 * suppression mechanism exists.
 *
 * Exit codes: 0 = clean · 1 = violations · 2 = configuration error.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI + paths
// ---------------------------------------------------------------------------

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

const scanRoot = resolve(argValue('--root') ?? join(appDir, 'src'));
const allowlistPath = resolve(
  argValue('--allowlist') ?? join(appDir, 'src', 'chrome', 'theme', 'tokens.css'),
);

if (!existsSync(allowlistPath)) {
  console.error(
    `token-lint: allowlist not found at ${allowlistPath}\n` +
      `           run \`pnpm -F aibender-app build:tokens\` first (tokens.css is generated).`,
  );
  process.exit(2);
}
if (!existsSync(scanRoot)) {
  console.error(`token-lint: scan root not found: ${scanRoot}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Allowlist (from generated tokens.css — single source of truth chain)
// ---------------------------------------------------------------------------

function expandHex(raw) {
  const h = raw.toLowerCase();
  const body = h.slice(1);
  if (body.length === 3 || body.length === 4) {
    return '#' + [...body].map((c) => c + c).join('');
  }
  return h;
}

const normalizeFn = (s) => s.replace(/\s+/g, '').toLowerCase();

const allowSource = readFileSync(allowlistPath, 'utf8');
const allowHex = new Set(
  [...allowSource.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => expandHex(m[0])),
);
const allowColorFn = new Set(
  [...allowSource.matchAll(/(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/g)].map((m) =>
    normalizeFn(m[0]),
  ),
);
const allowEase = new Set(
  [...allowSource.matchAll(/cubic-bezier\([^)]*\)/g)].map((m) => normalizeFn(m[0])),
);

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'target']);

/**
 * The token source of truth is exempt — it is where the values are DEFINED.
 * Anchored to EXACTLY <scanRoot>/chrome/theme/ with path-segment boundaries
 * (DESIGN.md §8.3 scopes the exemption to `app/src/chrome/theme/` and §8.4
 * allows no other suppression channel): a substring match would let a build
 * agent evade the whole lint via directory naming (`features/chrome/theme/`,
 * `chrome/themed/`, …).
 */
function isThemeExempt(rel) {
  const parts = rel.split(sep);
  return parts[0] === 'chrome' && parts[1] === 'theme' && parts.length > 2;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1) continue;
      if (!SCAN_EXT.has(entry.name.slice(dot))) continue;
      if (isThemeExempt(relative(scanRoot, full))) continue;
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Rules — each returns violation detail strings for one line of text
// ---------------------------------------------------------------------------

const VALID_HEX_LEN = new Set([3, 4, 6, 8]);

function* checkLine(text) {
  // off-token-hex
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (!VALID_HEX_LEN.has(m[0].length - 1)) continue;
    if (!allowHex.has(expandHex(m[0]))) {
      yield ['off-token-hex', `hex ${m[0]} is not an Instrument Grade token`];
    }
  }

  // color-fn
  for (const m of text.matchAll(/(?<![a-zA-Z-])(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/g)) {
    if (!allowColorFn.has(normalizeFn(m[0]))) {
      yield ['color-fn', `color literal ${m[0]} is not an Instrument Grade token`];
    }
  }

  // radius — CSS/inline-style values
  const radiusValues = [
    ...[...text.matchAll(/border-radius\s*:\s*([^;}]+)/gi)].map((m) => m[1]),
    ...[...text.matchAll(/borderRadius\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
  ];
  for (const value of radiusValues) {
    if (value.includes('var(--ig-radius-')) continue;
    let bad = false;
    for (const px of value.matchAll(/([0-9]*\.?[0-9]+)px/g)) {
      if (parseFloat(px[1]) > 2) bad = true;
    }
    if (/[0-9](rem|em|%)/.test(value)) bad = true; // relative radii can exceed 2px
    if (bad) yield ['radius', `border-radius "${value.trim()}" exceeds the 0–2px token range`];
  }
  // radius — Tailwind utilities
  for (const m of text.matchAll(
    /(?:^|[\s'"`])rounded(?:-[a-z]{1,2})?-(?:sm|md|lg|xl|2xl|3xl|4xl|full)\b/g,
  )) {
    yield ['radius', `utility "${m[0].trim()}" exceeds the 0–2px token range`];
  }
  for (const m of text.matchAll(/rounded(?:-[a-z]{1,2})?-\[([0-9.]+)(px|rem|em)\]/g)) {
    if (m[2] !== 'px' || parseFloat(m[1]) > 2) {
      yield ['radius', `utility "${m[0]}" exceeds the 0–2px token range`];
    }
  }

  // shadow
  const shadowValues = [
    ...[...text.matchAll(/(?<![a-zA-Z-])(?:box|text)-shadow\s*:\s*([^;}]+)/gi)].map((m) => m[1]),
    ...[...text.matchAll(/(?:boxShadow|textShadow)\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
  ];
  for (const value of shadowValues) {
    const v = value.trim();
    if (v === 'none' || v.includes('var(--ig-shadow)')) continue;
    yield ['shadow', `shadow "${v}" — shadows do not exist in Instrument Grade`];
  }
  for (const m of text.matchAll(
    /(?:^|[\s'"`])(?:inset-shadow|text-shadow|drop-shadow|shadow)-(?!none\b)[a-z0-9[][^\s'"`]*/g,
  )) {
    yield ['shadow', `utility "${m[0].trim()}" — shadows do not exist in Instrument Grade`];
  }
  // shadow — the CSS filter-function form (filter/backdrop-filter/inline
  // filter={{…}}). Token-colored glows included: DESIGN.md §7 item 4 forbids
  // any drop-shadow ≠ none, and §2.3 sanctions the halo ONLY via
  // color/opacity/outline — never a shadow of any species.
  if (/drop-shadow\s*\(/i.test(text)) {
    yield [
      'shadow',
      'drop-shadow() filter — shadows/colored glows do not exist in Instrument Grade',
    ];
  }

  // gradient
  if (/(linear|radial|conic)-gradient\s*\(/i.test(text)) {
    yield ['gradient', 'gradients are FORBIDDEN (DESIGN.md §7)'];
  }
  for (const m of text.matchAll(/(?:^|[\s'"`])bg-gradient-[^\s'"`]*/g)) {
    yield ['gradient', `utility "${m[0].trim()}" — gradients are FORBIDDEN`];
  }

  // glass
  if (/backdrop-filter|backdropFilter/.test(text) || /(?:^|[\s'"`])backdrop-blur/.test(text)) {
    yield ['glass', 'backdrop-filter/backdrop-blur (glassmorphism) is FORBIDDEN'];
  }

  // font-family
  if (/font-family\s*:|fontFamily\s*:/.test(text) && !text.includes('var(--ig-font-')) {
    yield ['font-family', 'literal font stack — use var(--ig-font-mono|--ig-font-display)'];
  }
  for (const m of text.matchAll(/['"](Inter|Geist|Space\s?Grotesk|Roboto)['"]/g)) {
    yield ['font-family', `forbidden face ${m[0]} (DESIGN.md §7)`];
  }

  // easing
  if (/type:\s*['"]spring['"]/.test(text) || /(?<![a-zA-Z])spring\(/.test(text)) {
    yield ['easing', 'spring/bounce easing is FORBIDDEN — use var(--ig-ease-mechanical)'];
  }
  for (const m of text.matchAll(/cubic-bezier\([^)]*\)/g)) {
    if (!allowEase.has(normalizeFn(m[0]))) {
      yield ['easing', `off-token easing ${m[0]} — only mechanical/decay exist`];
    }
  }

  // iconography
  if (/[✨\u{1FA84}\u{1F916}\u{1F9E0}⚡]/u.test(text)) {
    yield ['iconography', 'sparkles/wand/robot/brain/zap glyphs are FORBIDDEN AI iconography'];
  }
  if (/^\s*import\b.*sparkle/i.test(text)) {
    yield ['iconography', 'sparkle icon import — FORBIDDEN AI iconography'];
  }

  // loader
  if (/animate-pulse|shimmer|skeleton/i.test(text)) {
    yield ['loader', 'skeleton/shimmer loaders are FORBIDDEN (dim + NO SIGNAL semantics instead)'];
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const violations = [];
let filesScanned = 0;

for (const file of walk(scanRoot)) {
  filesScanned += 1;
  const rel = relative(scanRoot, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((lineText, i) => {
    if (lineText.includes('token-lint-allow')) return;
    for (const [rule, detail] of checkLine(lineText)) {
      violations.push({ rule, rel, line: i + 1, detail });
    }
  });
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`  ${v.rule.padEnd(14)} ${v.rel}:${v.line}  ${v.detail}`);
  }
  const files = new Set(violations.map((v) => v.rel)).size;
  console.error(
    `token-lint: FAIL — ${violations.length} violation(s) in ${files} file(s) ` +
      `(scanned ${filesScanned} under ${relative(process.cwd(), scanRoot) || '.'})`,
  );
  process.exit(1);
}

console.log(`token-lint: OK — ${filesScanned} file(s) scanned, 0 violations`);
