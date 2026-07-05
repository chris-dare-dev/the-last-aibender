/**
 * Instrument Grade → graph island theme bridge (DESIGN.md §8.5: canvas/WebGL
 * islands read `--ig-*` via getComputedStyle at init — hex literals never
 * enter island code; the generated tokens.css is the single source of truth).
 *
 * Missing values resolve to `undefined` and the renderer LEAVES ITS DEFAULTS
 * in place (unset tint/background) rather than inventing colors — the FE-3
 * doctrine.
 *
 * Also read here:
 *  - camera fly-to duration/easing (`--ig-motion-camera-ease-duration` /
 *    `--ig-motion-camera-ease-ease`, DESIGN.md §3.4). Under
 *    `prefers-reduced-motion` the generated CSS zeroes the duration, so the
 *    fly-to collapses to the mandated jump cut with no extra logic;
 *  - the phosphor-decay pair (§3.2) driving node enter/pulse fades;
 *  - the `--ig-reduced-motion` marker (the media-remap sets it to 1).
 */

export interface GraphTokenTheme {
  /** Canvas clear color (surface-well). */
  readonly background?: number;
  /** Node ink: sessions (primary), artifacts (secondary), dim (muted). */
  readonly inkPrimary?: number;
  readonly inkSecondary?: number;
  readonly inkMuted?: number;
  readonly inkFaint?: number;
  /** THE amber — the actively-touched-artifact pulse only. */
  readonly accent?: number;
  readonly accentHalo?: { readonly color: number; readonly alpha: number };
  readonly hairline?: number;
  /** Camera fly-to (ms; 0 under reduced motion = jump cut). */
  readonly cameraEaseMs: number;
  /** Cubic-bezier control points for Motion `animate()` easing. */
  readonly cameraEase?: readonly [number, number, number, number];
  /** Phosphor decay duration (ms; 0 under reduced motion). */
  readonly phosphorDecayMs: number;
  /** True when the reduced-motion remap is active. */
  readonly reducedMotion: boolean;
}

function readVar(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : undefined;
}

/** `#RRGGBB`/`#RGB` → numeric color, else undefined. */
export function parseHexColor(value: string | undefined): number | undefined {
  if (value === undefined || !value.startsWith('#')) return undefined;
  let body = value.slice(1);
  if (body.length === 3) body = [...body].map((c) => c + c).join('');
  if (body.length !== 6) return undefined;
  const parsed = Number.parseInt(body, 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** rgb/rgba color strings → color + alpha, else undefined. */
export function parseRgba(
  value: string | undefined,
): { color: number; alpha: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (match === null) return undefined;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if ([r, g, b].some((c) => !Number.isFinite(c) || c > 255) || !Number.isFinite(alpha)) {
    return undefined;
  }
  return { color: (r << 16) | (g << 8) | b, alpha };
}

/**
 * Any color-with-alpha form → color + alpha. Handles the rgba function form
 * AND the 4/8-digit hex forms: CSS minifiers (the Vite/esbuild pipeline that
 * builds the app) legally rewrite rgba-function tokens into hex-alpha form,
 * so the runtime read must accept both spellings of the same token.
 */
export function parseColorWithAlpha(
  value: string | undefined,
): { color: number; alpha: number } | undefined {
  const fromRgba = parseRgba(value);
  if (fromRgba !== undefined) return fromRgba;
  if (value === undefined || !value.startsWith('#')) return undefined;
  let body = value.slice(1);
  if (body.length === 3 || body.length === 4) body = [...body].map((c) => c + c).join('');
  if (body.length === 6) {
    const color = parseHexColor('#' + body);
    return color === undefined ? undefined : { color, alpha: 1 };
  }
  if (body.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(body)) return undefined;
  const color = Number.parseInt(body.slice(0, 6), 16);
  const alpha = Number.parseInt(body.slice(6), 16) / 255;
  return { color, alpha };
}

/** `320ms` / `0.32s` → milliseconds (undefined when absent/unparseable). */
export function parseDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([\d.]+)\s*(ms|s)$/.exec(value);
  if (match === null) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  return match[2] === 's' ? n * 1000 : n;
}

/** cubic-bezier easing strings → control points. */
export function parseCubicBezier(
  value: string | undefined,
): readonly [number, number, number, number] | undefined {
  if (value === undefined) return undefined;
  const match = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(
    value,
  );
  if (match === null) return undefined;
  const pts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  if (pts.some((p) => !Number.isFinite(p))) return undefined;
  return pts as unknown as readonly [number, number, number, number];
}

/** Read the graph theme from the computed style of the island container. */
export function readGraphTokenTheme(container: HTMLElement): GraphTokenTheme {
  const styles = getComputedStyle(container);
  const background = parseHexColor(readVar(styles, '--ig-surface-well'));
  const inkPrimary = parseHexColor(readVar(styles, '--ig-ink-primary'));
  const inkSecondary = parseHexColor(readVar(styles, '--ig-ink-secondary'));
  const inkMuted = parseHexColor(readVar(styles, '--ig-ink-muted'));
  const inkFaint = parseHexColor(readVar(styles, '--ig-ink-faint'));
  const accent = parseHexColor(readVar(styles, '--ig-accent'));
  const accentHalo = parseColorWithAlpha(readVar(styles, '--ig-accent-halo'));
  const hairline = parseHexColor(readVar(styles, '--ig-line-hairline'));
  const cameraEaseMs = parseDurationMs(readVar(styles, '--ig-motion-camera-ease-duration')) ?? 0;
  const cameraEase =
    parseCubicBezier(readVar(styles, '--ig-motion-camera-ease-ease')) ??
    parseCubicBezier(readVar(styles, '--ig-ease-mechanical'));
  const phosphorDecayMs =
    parseDurationMs(readVar(styles, '--ig-motion-phosphor-decay-duration')) ?? 0;
  const reducedMotion =
    readVar(styles, '--ig-reduced-motion') === '1' ||
    (typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches);

  return {
    ...(background !== undefined ? { background } : {}),
    ...(inkPrimary !== undefined ? { inkPrimary } : {}),
    ...(inkSecondary !== undefined ? { inkSecondary } : {}),
    ...(inkMuted !== undefined ? { inkMuted } : {}),
    ...(inkFaint !== undefined ? { inkFaint } : {}),
    ...(accent !== undefined ? { accent } : {}),
    ...(accentHalo !== undefined ? { accentHalo } : {}),
    ...(hairline !== undefined ? { hairline } : {}),
    cameraEaseMs,
    ...(cameraEase !== undefined ? { cameraEase } : {}),
    phosphorDecayMs,
    reducedMotion,
  };
}
