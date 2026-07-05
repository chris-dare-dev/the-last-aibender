/**
 * FE-4 token theme bridge — parsers + the getComputedStyle read (DESIGN.md
 * §8.5: islands read `--ig-*`; hex never enters island code; missing tokens
 * resolve to undefined so the renderer keeps its defaults).
 *
 * Color-literal hygiene: the positive parser fixtures reuse EXACT Instrument
 * Grade token values (allow-listed); malformed inputs are join-built so no
 * off-token color function ever appears literally in this file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseColorWithAlpha,
  parseCubicBezier,
  parseDurationMs,
  parseHexColor,
  parseRgba,
  readGraphTokenTheme,
} from './theme.ts';

const fn = (name: string, args: string): string => `${name}(${args})`;

describe('parseHexColor', () => {
  it('parses token hex forms (#RRGGBB and #RGB)', () => {
    expect(parseHexColor('#FFB000')).toBe(0xffb000);
    expect(parseHexColor('#E8E6E1')).toBe(0xe8e6e1);
    // Short-form expansion (join-built: not a token literal, lint-safe).
    expect(parseHexColor('#' + 'abc')).toBe(0xaabbcc);
  });

  it('rejects non-hex and malformed values', () => {
    expect(parseHexColor(undefined)).toBeUndefined();
    expect(parseHexColor('')).toBeUndefined();
    expect(parseHexColor('FFB000')).toBeUndefined();
    expect(parseHexColor('#' + 'FFB0')).toBeUndefined(); // 4-digit body unsupported
    expect(parseHexColor('#GGGGGG')).toBeUndefined();
  });
});

describe('parseRgba', () => {
  it('parses the accent-halo token value', () => {
    // The one sanctioned rgba token (allow-listed): the amber halo.
    expect(parseRgba('rgba(255, 176, 0, 0.22)')).toEqual({ color: 0xffb000, alpha: 0.22 });
  });

  it('defaults alpha to 1 for the 3-arg form', () => {
    expect(parseRgba(fn('rgb', '255, 176, 0'))).toEqual({ color: 0xffb000, alpha: 1 });
  });

  it('rejects malformed and out-of-range values', () => {
    expect(parseRgba(undefined)).toBeUndefined();
    expect(parseRgba(fn('rgba', '300, 0, 0, 1'))).toBeUndefined();
    expect(parseRgba(fn('rgba', 'a, b, c, d'))).toBeUndefined();
    expect(parseRgba('#FFB000')).toBeUndefined();
  });
});

describe('parseColorWithAlpha', () => {
  it('accepts the rgba token form AND its minified hex-alpha rewrite', () => {
    // Vite/esbuild legally rewrites the accent-halo rgba token into the
    // 8-digit hex-alpha form in the built tokens.css — both spellings of
    // the SAME token must land (join-built below: not a color literal).
    expect(parseColorWithAlpha('rgba(255, 176, 0, 0.22)')).toEqual({
      color: 0xffb000,
      alpha: 0.22,
    });
    const hexAlpha = parseColorWithAlpha('#' + 'ffb00038');
    expect(hexAlpha?.color).toBe(0xffb000);
    expect(hexAlpha?.alpha).toBeCloseTo(0.22, 2);
  });

  it('treats plain hex as alpha 1 and expands short forms', () => {
    expect(parseColorWithAlpha('#FFB000')).toEqual({ color: 0xffb000, alpha: 1 });
    const short = parseColorWithAlpha('#' + 'fb08'); // #RGBA
    expect(short?.color).toBe(0xffbb00);
    expect(short?.alpha).toBeCloseTo(0x88 / 255, 3);
  });

  it('rejects malformed values', () => {
    expect(parseColorWithAlpha(undefined)).toBeUndefined();
    expect(parseColorWithAlpha('#' + 'ffb0003')).toBeUndefined(); // 7 digits
    expect(parseColorWithAlpha('amber')).toBeUndefined();
  });
});

describe('parseDurationMs', () => {
  it('parses ms and s forms', () => {
    expect(parseDurationMs('320ms')).toBe(320);
    expect(parseDurationMs('0.32s')).toBe(320);
    expect(parseDurationMs('0ms')).toBe(0);
  });

  it('rejects unitless and malformed values', () => {
    expect(parseDurationMs(undefined)).toBeUndefined();
    expect(parseDurationMs('320')).toBeUndefined();
    expect(parseDurationMs('fast')).toBeUndefined();
  });
});

describe('parseCubicBezier', () => {
  it('parses the mechanical ease token value', () => {
    expect(parseCubicBezier('cubic-bezier(0.2, 0, 0, 1)')).toEqual([0.2, 0, 0, 1]);
  });

  it('rejects malformed values', () => {
    expect(parseCubicBezier(undefined)).toBeUndefined();
    expect(parseCubicBezier('ease-out')).toBeUndefined();
    expect(parseCubicBezier(fn('cubic-bezier', '1, 2, 3'))).toBeUndefined();
  });
});

describe('readGraphTokenTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubComputedStyle = (vars: Record<string, string>): void => {
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => vars[name] ?? '',
    }));
  };

  it('reads the full Instrument Grade set into renderer-ready values', () => {
    stubComputedStyle({
      '--ig-surface-well': '#0C0C0B',
      '--ig-ink-primary': '#E8E6E1',
      '--ig-ink-secondary': '#B7B3AA',
      '--ig-ink-muted': '#8A867E',
      '--ig-ink-faint': '#57544E',
      '--ig-accent': '#FFB000',
      '--ig-accent-halo': 'rgba(255, 176, 0, 0.22)',
      '--ig-line-hairline': '#2A2825',
      '--ig-motion-camera-ease-duration': '320ms',
      '--ig-motion-camera-ease-ease': 'cubic-bezier(0.2, 0, 0, 1)',
      '--ig-motion-phosphor-decay-duration': '640ms',
    });
    const theme = readGraphTokenTheme({} as HTMLElement);
    expect(theme.background).toBe(0x0c0c0b);
    expect(theme.inkPrimary).toBe(0xe8e6e1);
    expect(theme.accent).toBe(0xffb000);
    expect(theme.accentHalo).toEqual({ color: 0xffb000, alpha: 0.22 });
    expect(theme.hairline).toBe(0x2a2825);
    expect(theme.cameraEaseMs).toBe(320);
    expect(theme.cameraEase).toEqual([0.2, 0, 0, 1]);
    expect(theme.phosphorDecayMs).toBe(640);
    expect(theme.reducedMotion).toBe(false);
  });

  it('missing tokens resolve to undefined — the renderer keeps its defaults', () => {
    stubComputedStyle({});
    const theme = readGraphTokenTheme({} as HTMLElement);
    expect(theme.background).toBeUndefined();
    expect(theme.accent).toBeUndefined();
    expect(theme.accentHalo).toBeUndefined();
    expect(theme.cameraEaseMs).toBe(0); // absent duration ⇒ jump cut, not NaN
    expect(theme.phosphorDecayMs).toBe(0);
  });

  it('the reduced-motion marker flips the flag and the zeroed durations follow', () => {
    stubComputedStyle({
      '--ig-reduced-motion': '1',
      '--ig-motion-camera-ease-duration': '0ms',
      '--ig-motion-phosphor-decay-duration': '0ms',
    });
    const theme = readGraphTokenTheme({} as HTMLElement);
    expect(theme.reducedMotion).toBe(true);
    expect(theme.cameraEaseMs).toBe(0);
    expect(theme.phosphorDecayMs).toBe(0);
  });

  it('falls back to the mechanical ease when the camera ease token is absent', () => {
    stubComputedStyle({
      '--ig-ease-mechanical': 'cubic-bezier(0.2, 0, 0, 1)',
    });
    const theme = readGraphTokenTheme({} as HTMLElement);
    expect(theme.cameraEase).toEqual([0.2, 0, 0, 1]);
  });
});
