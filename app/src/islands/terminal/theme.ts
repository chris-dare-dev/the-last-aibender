/**
 * Instrument Grade → xterm theme bridge (DESIGN.md §8.5: canvas/WebGL islands
 * read `--ig-*` via getComputedStyle at init — hex literals never enter
 * island code; the generated tokens.css is the single source of truth).
 *
 * Values missing (tokens.css not loaded — a harness/composition bug) resolve
 * to `undefined`, which leaves xterm's own defaults in place rather than
 * inventing colors here.
 */

export interface TerminalTokenTheme {
  readonly theme: {
    readonly background?: string;
    readonly foreground?: string;
    readonly cursor?: string;
    readonly cursorAccent?: string;
    readonly selectionBackground?: string;
  };
  readonly fontFamily?: string;
  readonly fontSize?: number;
}

function readVar(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : undefined;
}

/** Read the terminal's token theme from the computed style of its container. */
export function readTerminalTokenTheme(container: HTMLElement): TerminalTokenTheme {
  const styles = getComputedStyle(container);
  const background = readVar(styles, '--ig-surface-well');
  const foreground = readVar(styles, '--ig-ink-primary');
  const cursor = readVar(styles, '--ig-accent');
  const cursorAccent = readVar(styles, '--ig-ink-on-accent');
  const selectionBackground = readVar(styles, '--ig-accent-halo');
  const fontFamily = readVar(styles, '--ig-font-mono');
  const fontSizeRaw = readVar(styles, '--ig-type-data');
  const fontSize = fontSizeRaw === undefined ? undefined : Number.parseFloat(fontSizeRaw);

  return {
    theme: {
      ...(background !== undefined ? { background } : {}),
      ...(foreground !== undefined ? { foreground } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(cursorAccent !== undefined ? { cursorAccent } : {}),
      ...(selectionBackground !== undefined ? { selectionBackground } : {}),
    },
    ...(fontFamily !== undefined ? { fontFamily } : {}),
    ...(fontSize !== undefined && Number.isFinite(fontSize) ? { fontSize } : {}),
  };
}
