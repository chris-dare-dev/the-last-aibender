/**
 * Instrument Grade token renderers (FE-1).
 *
 * Pure functions: tokens.ts → CSS text. `scripts/build-tokens.ts` writes the
 * output to `tokens.css` and `tailwind.theme.css`; tests assert the committed
 * files match these renderers byte-for-byte (drift guard).
 */

import {
  accent,
  channelOrder,
  channels,
  focus,
  font,
  grid,
  ink,
  latency,
  layout,
  line,
  motion,
  numeric,
  palette,
  radius,
  shadow,
  space,
  status,
  surface,
  tracking,
  type,
} from './tokens.ts';

const HEADER = (target: string): string =>
  [
    `/*`,
    ` * GENERATED FILE — DO NOT EDIT.`,
    ` * Source of truth: app/src/chrome/theme/tokens.ts (normative spec: /DESIGN.md).`,
    ` * Regenerate with: pnpm -F aibender-app build:tokens`,
    ` * Target: ${target}`,
    ` */`,
    ``,
  ].join('\n');

const kebab = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

/** `tokens.css` — raw `--ig-*` custom properties for every runtime consumer
 *  (CSS, and canvas/WebGL islands that read via getComputedStyle). */
export function renderTokensCss(): string {
  const root: Array<[string, string]> = [];

  // Surfaces
  root.push(['--ig-surface-base', surface.base]);
  root.push(['--ig-surface-panel', surface.panel]);
  root.push(['--ig-surface-raised', surface.raised]);
  root.push(['--ig-surface-well', surface.well]);
  root.push(['--ig-surface-scrim', surface.scrim]);

  // Ink
  root.push(['--ig-ink-primary', ink.primary]);
  root.push(['--ig-ink-secondary', ink.secondary]);
  root.push(['--ig-ink-muted', ink.muted]);
  root.push(['--ig-ink-faint', ink.faint]);
  root.push(['--ig-ink-on-accent', ink.onAccent]);

  // Accent
  root.push(['--ig-accent', accent.amber]);
  root.push(['--ig-accent-press', accent.press]);
  root.push(['--ig-accent-halo', accent.halo]);

  // Status
  root.push(['--ig-status-ok', status.ok]);
  root.push(['--ig-status-degraded', status.degraded]);
  root.push(['--ig-status-fault', status.fault]);
  root.push(['--ig-status-nosignal', status.nosignal]);
  root.push(['--ig-status-ok-tint', status.okTint]);
  root.push(['--ig-status-degraded-tint', status.degradedTint]);
  root.push(['--ig-status-fault-tint', status.faultTint]);

  // Channels (fixed slot order)
  for (const id of channelOrder) {
    const c = channels[id];
    root.push([`--ig-channel-${kebab(id)}`, c.indexHue]);
  }

  // Lines
  root.push(['--ig-line-hairline', line.hairline]);
  root.push(['--ig-line-emphasis', line.emphasis]);
  root.push(['--ig-line-width', `${line.widthPx}px`]);

  // Radii + shadow
  root.push(['--ig-radius-0', radius.r0]);
  root.push(['--ig-radius-1', radius.r1]);
  root.push(['--ig-radius-2', radius.r2]);
  root.push(['--ig-shadow', shadow.none]);

  // Spacing + character grid
  root.push(['--ig-space-unit', `${space.unitPx}px`]);
  for (const s of space.steps) root.push([`--ig-space-${s}`, `${s}px`]);
  root.push(['--ig-grid-ch', grid.ch]);
  root.push(['--ig-grid-row', `${grid.rowPx}px`]);

  // Typography
  root.push(['--ig-font-mono', font.mono]);
  root.push(['--ig-font-display', font.display]);
  for (const [name, step] of Object.entries(type)) {
    root.push([`--ig-type-${kebab(name)}`, `${step.sizePx}px`]);
    root.push([`--ig-type-${kebab(name)}-lh`, `${step.lineHeightPx}px`]);
  }
  root.push(['--ig-tracking-engraved', tracking.engraved]);
  root.push(['--ig-numeric', numeric.fontVariantNumeric]);

  // Motion
  root.push(['--ig-motion-fast', `${motion.duration.fastMs}ms`]);
  root.push(['--ig-motion-base', `${motion.duration.baseMs}ms`]);
  root.push(['--ig-motion-deliberate', `${motion.duration.deliberateMs}ms`]);
  root.push(['--ig-ease-mechanical', motion.ease.mechanical]);
  root.push(['--ig-ease-decay', motion.ease.decay]);
  for (const [name, spec] of Object.entries(motion.animated)) {
    root.push([`--ig-motion-${kebab(name)}-duration`, `${spec.durationMs}ms`]);
    root.push([`--ig-motion-${kebab(name)}-ease`, spec.easing]);
  }

  // Latency budgets (instrumentation-visible)
  root.push(['--ig-latency-interaction', `${latency.interactionFeedbackMs}ms`]);
  root.push(['--ig-latency-keystroke-echo-p95', `${latency.keystrokeEchoP95Ms}ms`]);
  root.push(['--ig-latency-palette-open', `${latency.paletteOpenMs}ms`]);
  root.push(['--ig-latency-spinner-threshold', `${latency.spinnerThresholdMs}ms`]);
  root.push(['--ig-latency-ceremony-budget', `${latency.ceremonyBudgetMs}ms`]);

  // Command palette
  root.push(['--ig-palette-width', `${palette.widthPx}px`]);
  root.push(['--ig-palette-offset-y', `${palette.offsetYPx}px`]);
  root.push(['--ig-palette-row', `${palette.rowPx}px`]);
  root.push(['--ig-palette-max-rows', `${palette.maxRows}`]);

  // Layout zones + breakpoints
  root.push(['--ig-zone-left', `${layout.zone.leftPx}px`]);
  root.push(['--ig-zone-right', `${layout.zone.rightPx}px`]);
  root.push(['--ig-zone-center-min', `${layout.zone.centerMinPx}px`]);
  root.push(['--ig-breakpoint-compact', `${layout.breakpoint.compactPx}px`]);
  root.push(['--ig-breakpoint-cockpit', `${layout.breakpoint.cockpitPx}px`]);
  root.push(['--ig-breakpoint-ultrawide', `${layout.breakpoint.ultrawidePx}px`]);

  // Focus
  root.push(['--ig-focus-outline', focus.outline]);
  root.push(['--ig-focus-offset', focus.offset]);

  const rootBlock = [':root {', ...root.map(([k, v]) => `  ${k}: ${v};`), '}'].join('\n');

  // Reduced-motion: total mapping — EVERY animated token is remapped here.
  const reduced: string[] = ['  :root {', '    --ig-reduced-motion: 1;'];
  for (const name of Object.keys(motion.animated)) {
    reduced.push(`    --ig-motion-${kebab(name)}-duration: 0ms;`);
  }
  reduced.push('  }');
  const reducedBlock = [
    '/* Reduced-motion mapping (DESIGN.md §3.5) — total over motion.animated:',
    ' * every animated token collapses to duration 0; "discrete"-mode tokens',
    ' * additionally follow their non-tweened spec (see tokens.ts).',
    ' */',
    '@media (prefers-reduced-motion: reduce) {',
    ...reduced,
    '}',
  ].join('\n');

  return `${HEADER('runtime custom properties')}${rootBlock}\n\n${reducedBlock}\n`;
}

/** `tailwind.theme.css` — Tailwind 4 `@theme` consuming ONLY the tokens.
 *  Default namespaces are reset to `initial` first so off-token utilities
 *  (bg-indigo-500, shadow-xl, rounded-2xl, blur-md…) simply do not exist. */
export function renderTailwindTheme(): string {
  const lines: string[] = [];
  lines.push('@theme {');
  lines.push('  /* -- Anti-slop resets: default palettes/scales are erased. -- */');
  for (const ns of [
    '--color-*',
    '--font-*',
    '--text-*',
    '--radius-*',
    '--shadow-*',
    '--inset-shadow-*',
    '--drop-shadow-*',
    '--text-shadow-*',
    '--blur-*',
    '--ease-*',
    '--animate-*',
    '--tracking-*',
    '--breakpoint-*',
  ]) {
    lines.push(`  ${ns}: initial;`);
  }
  lines.push('');
  lines.push('  /* -- Instrument Grade tokens (source: tokens.ts) -- */');
  lines.push(`  --spacing: ${space.unitPx}px;`);
  lines.push('');
  lines.push(`  --color-surface-base: ${surface.base};`);
  lines.push(`  --color-surface-panel: ${surface.panel};`);
  lines.push(`  --color-surface-raised: ${surface.raised};`);
  lines.push(`  --color-surface-well: ${surface.well};`);
  lines.push(`  --color-scrim: ${surface.scrim};`);
  lines.push(`  --color-ink: ${ink.primary};`);
  lines.push(`  --color-ink-secondary: ${ink.secondary};`);
  lines.push(`  --color-ink-muted: ${ink.muted};`);
  lines.push(`  --color-ink-faint: ${ink.faint};`);
  lines.push(`  --color-ink-on-accent: ${ink.onAccent};`);
  lines.push(`  --color-accent: ${accent.amber};`);
  lines.push(`  --color-accent-press: ${accent.press};`);
  lines.push(`  --color-accent-halo: ${accent.halo};`);
  lines.push(`  --color-ok: ${status.ok};`);
  lines.push(`  --color-degraded: ${status.degraded};`);
  lines.push(`  --color-fault: ${status.fault};`);
  lines.push(`  --color-nosignal: ${status.nosignal};`);
  lines.push(`  --color-ok-tint: ${status.okTint};`);
  lines.push(`  --color-degraded-tint: ${status.degradedTint};`);
  lines.push(`  --color-fault-tint: ${status.faultTint};`);
  for (const id of channelOrder) {
    lines.push(`  --color-channel-${kebab(id)}: ${channels[id].indexHue};`);
  }
  lines.push(`  --color-line-hairline: ${line.hairline};`);
  lines.push(`  --color-line-emphasis: ${line.emphasis};`);
  lines.push('');
  lines.push(`  --font-mono: ${font.mono};`);
  lines.push(`  --font-display: ${font.display};`);
  for (const [name, step] of Object.entries(type)) {
    lines.push(`  --text-${kebab(name)}: ${step.sizePx}px;`);
    lines.push(`  --text-${kebab(name)}--line-height: ${step.lineHeightPx}px;`);
  }
  lines.push(`  --tracking-engraved: ${tracking.engraved};`);
  lines.push('');
  lines.push(`  --radius-1: ${radius.r1};`);
  lines.push(`  --radius-2: ${radius.r2};`);
  lines.push('');
  lines.push(`  --ease-mechanical: ${motion.ease.mechanical};`);
  lines.push(`  --ease-decay: ${motion.ease.decay};`);
  lines.push('');
  lines.push(`  --breakpoint-compact: ${layout.breakpoint.compactPx}px;`);
  lines.push(`  --breakpoint-cockpit: ${layout.breakpoint.cockpitPx}px;`);
  lines.push(`  --breakpoint-ultrawide: ${layout.breakpoint.ultrawidePx}px;`);
  lines.push('}');
  return `${HEADER('Tailwind 4 @theme (utilities exist ONLY for these tokens)')}${lines.join('\n')}\n`;
}
