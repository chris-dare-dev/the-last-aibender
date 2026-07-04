/**
 * Instrument Grade design tokens — SINGLE SOURCE OF TRUTH (FE-1).
 *
 * Normative spec: /DESIGN.md (repo root). This file implements it 1:1; the two
 * CSS artifacts next to it (`tokens.css`, `tailwind.theme.css`) are GENERATED
 * from this file by `pnpm -F app build:tokens` and must never be hand-edited.
 *
 * Change control: any value change here requires a matching DESIGN.md edit and
 * FE-ORCH sign-off (plan §5 FE-1 — DESIGN.md is the lock; this file follows it).
 *
 * [X2] This file is public. Channel identifiers are the placeholder labels
 * MAX_A / MAX_B / ENT / BEDROCK / LMSTUDIO only — never real account data.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelId = 'MAX_A' | 'MAX_B' | 'ENT' | 'BEDROCK' | 'LMSTUDIO';

export interface ChannelToken {
  /** Placeholder channel id ([X2] — never a real account identifier). */
  readonly id: ChannelId;
  /** Engraved panel label text, rendered in the mono engraved style. */
  readonly label: string;
  /** Low-saturation identity hue. Index/tick use only — never fills or text. */
  readonly indexHue: string;
  /** Fixed panel position in the right-zone instrument stack (1 = top). */
  readonly slot: 1 | 2 | 3 | 4 | 5;
}

export interface ReducedMotionVariant {
  /**
   * 'instant'  — the transition simply does not run (duration 0, end state).
   * 'discrete' — animation replaced by non-tweened discrete state steps.
   */
  readonly mode: 'instant' | 'discrete';
  /** Human-readable normative behavior under prefers-reduced-motion. */
  readonly spec: string;
}

export interface AnimatedToken {
  readonly durationMs: number;
  /** Must be one of motion.ease.* values — no ad-hoc easings exist. */
  readonly easing: string;
  /** Only compositor-cheap properties are ever animated. */
  readonly properties: readonly string[];
  readonly description: string;
  /** REQUIRED: the reduced-motion mapping table is total by construction. */
  readonly reducedMotion: ReducedMotionVariant;
  /** Exactly ONE token in the system may set this (workstream lineage). */
  readonly ceremonial?: true;
}

// ---------------------------------------------------------------------------
// Color — surfaces (warm charcoal, never navy)
// ---------------------------------------------------------------------------

export const surface = {
  /** App background. Warm charcoal. */
  base: '#111110',
  /** Panel fill — one step up from base. */
  panel: '#1A1917',
  /** Raised interactive surfaces (palette, menus, dialogs). */
  raised: '#242220',
  /** Deep wells: terminal viewport, graph canvas. */
  well: '#0C0C0B',
  /** Modal scrim. Flat translucency — never backdrop-filter/blur. */
  scrim: 'rgba(12, 12, 11, 0.55)',
} as const;

// ---------------------------------------------------------------------------
// Color — ink (bone, never pure white)
// ---------------------------------------------------------------------------

export const ink = {
  /** Primary text/readouts. */
  primary: '#E8E6E1',
  /** Supporting copy, secondary readouts. */
  secondary: '#B7B3AA',
  /** Engraved labels, units, metadata. */
  muted: '#8A867E',
  /** Disabled controls and NO SIGNAL instruments (sub-AA by intent). */
  faint: '#57544E',
  /** Text placed on the amber accent. */
  onAccent: '#111110',
} as const;

// ---------------------------------------------------------------------------
// Color — the single accent (instrument amber)
// ---------------------------------------------------------------------------

export const accent = {
  /** Interactive/attention ONLY. Never large fills, never decoration. */
  amber: '#FFB000',
  /** Pressed/active state of amber controls. */
  press: '#D99600',
  /**
   * The ONLY sanctioned "glow": phosphor-decay live telemetry and the
   * live-artifact pulse in the context graph. Applied via color/opacity or
   * outline — NEVER via box-shadow.
   */
  halo: 'rgba(255, 176, 0, 0.22)',
} as const;

// ---------------------------------------------------------------------------
// Color — status (semantic use ONLY; meanings are normative, see DESIGN.md §2.4)
// ---------------------------------------------------------------------------

export const status = {
  /** Healthy / connected / within budget. */
  ok: '#3FB950',
  /** Soft-threshold breach / stale / retrying / approaching budget. */
  degraded: '#D29922',
  /** Hard failure / budget breached / auth lost. */
  fault: '#F85149',
  /** Source absent or off. Renders as a dimmed instrument — never fault red. */
  nosignal: '#57544E',
  /** 12% strips behind status rows — the only tinted backgrounds allowed. */
  okTint: 'rgba(63, 185, 80, 0.12)',
  degradedTint: 'rgba(210, 153, 34, 0.12)',
  faultTint: 'rgba(248, 81, 73, 0.12)',
} as const;

// ---------------------------------------------------------------------------
// Channels — fixed panel positions + engraved mono labels ([X2] placeholders)
// ---------------------------------------------------------------------------

export const channels: Readonly<Record<ChannelId, ChannelToken>> = {
  MAX_A: { id: 'MAX_A', label: 'MAX_A', indexHue: '#8FB0C9', slot: 1 },
  MAX_B: { id: 'MAX_B', label: 'MAX_B', indexHue: '#C9B18F', slot: 2 },
  ENT: { id: 'ENT', label: 'ENT', indexHue: '#8FC9B0', slot: 3 },
  BEDROCK: { id: 'BEDROCK', label: 'BEDROCK', indexHue: '#C98FA0', slot: 4 },
  LMSTUDIO: { id: 'LMSTUDIO', label: 'LMSTUDIO', indexHue: '#A0A69B', slot: 5 },
} as const;

/** Fixed top-to-bottom order of the channel instrument stack. */
export const channelOrder: readonly ChannelId[] = (
  Object.values(channels) as ChannelToken[]
)
  .slice()
  .sort((a, b) => a.slot - b.slot)
  .map((c) => c.id);

// ---------------------------------------------------------------------------
// Lines & borders (hairline rules instead of cards)
// ---------------------------------------------------------------------------

export const line = {
  hairline: '#2A2825',
  emphasis: '#3B3733',
  /** Every rule in the app is exactly this wide. */
  widthPx: 1,
} as const;

// ---------------------------------------------------------------------------
// Radii — 0–2px, nothing else exists
// ---------------------------------------------------------------------------

export const radius = {
  r0: '0px',
  r1: '1px',
  r2: '2px',
} as const;

// ---------------------------------------------------------------------------
// Shadows — none. (Kept as a token so the absence is explicit and testable.)
// ---------------------------------------------------------------------------

export const shadow = {
  none: 'none',
} as const;

// ---------------------------------------------------------------------------
// Spacing & the monospace character grid
// ---------------------------------------------------------------------------

export const space = {
  /** Base unit — all spacing is a multiple of this. */
  unitPx: 4,
  steps: [2, 4, 8, 12, 16, 20, 24, 32, 48] as readonly number[],
} as const;

export const grid = {
  /** Data surfaces are laid out on a character grid: columns in ch… */
  ch: '1ch',
  /** …and rows on a fixed 20px rhythm. */
  rowPx: 20,
} as const;

// ---------------------------------------------------------------------------
// Typography — license-clean faces only; font binaries NEVER enter the tree
// ---------------------------------------------------------------------------

export const font = {
  /**
   * Data / readouts / labels / code. "Berkeley Mono" and "TX-02" are optional
   * machine-local commercial faces (never committed); the committed reality is
   * the free stack: IBM Plex Mono (OFL), JetBrains Mono (OFL), Commit Mono (MIT).
   */
  mono: `"Berkeley Mono", "TX-02", "IBM Plex Mono", "JetBrains Mono", "Commit Mono", ui-monospace, "SF Mono", Menlo, monospace`,
  /**
   * UI / display grotesque. Cabinet Grotesk and General Sans via Fontshare
   * (ITF Free Font License — self-hostable, binaries still untracked).
   * Inter/Geist/Space Grotesk/Roboto are FORBIDDEN faces.
   */
  display: `"Cabinet Grotesk", "General Sans", system-ui, "Helvetica Neue", sans-serif`,
} as const;

export interface TypeStep {
  readonly sizePx: number;
  readonly lineHeightPx: number;
}

/** Scale ratio ≈1.28 across display steps (ui → heading → display → numeral). */
export const type = {
  label: { sizePx: 11, lineHeightPx: 16 },
  data: { sizePx: 12, lineHeightPx: 20 },
  body: { sizePx: 13, lineHeightPx: 20 },
  ui: { sizePx: 14, lineHeightPx: 20 },
  heading: { sizePx: 18, lineHeightPx: 24 },
  display: { sizePx: 23, lineHeightPx: 28 },
  numeral: { sizePx: 29, lineHeightPx: 32 },
  numeralLg: { sizePx: 36, lineHeightPx: 40 },
} as const satisfies Record<string, TypeStep>;

export const tracking = {
  /** Engraved panel labels only (the sanctioned uppercase-mono exception). */
  engraved: '0.08em',
} as const;

/** Numerals are ALWAYS tabular on data surfaces. */
export const numeric = {
  fontVariantNumeric: 'tabular-nums',
} as const;

// ---------------------------------------------------------------------------
// Motion grammar — mechanical, fast, ease-out only
// ---------------------------------------------------------------------------

export const motion = {
  duration: {
    fastMs: 120,
    baseMs: 150,
    deliberateMs: 180,
  },
  ease: {
    /** The only UI easing. Mechanical decelerate — a relay, not a spring. */
    mechanical: 'cubic-bezier(0.2, 0, 0, 1)',
    /** Phosphor-decay curve: steep initial luminance drop, long faint tail. */
    decay: 'cubic-bezier(0.19, 1, 0.22, 1)',
  },
  /**
   * Every animated behavior in the product is one of these tokens. The
   * reduced-motion column is total by type (ReducedMotionVariant is required).
   */
  animated: {
    'hover-feedback': {
      durationMs: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      properties: ['opacity', 'color'],
      description: 'Hover/press affordance on interactive controls.',
      reducedMotion: { mode: 'instant', spec: 'State applies with no tween.' },
    },
    'panel-transition': {
      durationMs: 150,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      properties: ['opacity', 'transform'],
      description: 'Panel/pane show-hide and zone collapse.',
      reducedMotion: {
        mode: 'instant',
        spec: 'Panels appear/disappear in a single frame.',
      },
    },
    'focus-shift': {
      durationMs: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      properties: ['transform'],
      description: 'Selection highlight moving through lists/menus.',
      reducedMotion: {
        mode: 'instant',
        spec: 'Highlight jumps to the new row; no travel.',
      },
    },
    'palette-open': {
      durationMs: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      properties: ['opacity', 'transform'],
      description: 'Command palette summon: fade + 8px translateY settle.',
      reducedMotion: {
        mode: 'instant',
        spec: 'Palette appears fully settled; no translate, no fade.',
      },
    },
    'phosphor-decay': {
      durationMs: 640,
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      properties: ['opacity', 'color'],
      description:
        'Live telemetry signature: instant 0ms attack to amber/bright, ' +
        '80ms hold, then 640ms decay to the resting ink color.',
      reducedMotion: {
        mode: 'discrete',
        spec:
          'No tween. A static amber freshness tick is shown while the sample ' +
          'is <2s old, then removed in a single step.',
      },
    },
    'camera-ease': {
      durationMs: 320,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      properties: ['transform'],
      description: 'Context-graph camera moves (via Motion animate()).',
      reducedMotion: {
        mode: 'instant',
        spec: 'No fly-to: jump cut to the target framing.',
      },
    },
    'ceremony-lineage': {
      durationMs: 480,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      properties: ['stroke-dashoffset', 'opacity'],
      description:
        'THE one ceremonial animation. Fires only on a ledger-committed ' +
        'workstream lineage event (branch/continue/merge): the new lineage ' +
        'edge draws itself over 480ms, then the terminal node ring lights ' +
        'amber instantly and phosphor-decays (640ms). Hard cap 1200ms total, ' +
        'never input-blocking, newest-only if events coalesce in one frame.',
      reducedMotion: {
        mode: 'discrete',
        spec:
          'Edge renders settled immediately; the terminal node shows a ' +
          'static amber ring for 1200ms, then reverts in one step.',
      },
      ceremonial: true,
    },
  },
} as const satisfies {
  duration: Record<string, number>;
  ease: Record<string, string>;
  animated: Record<string, AnimatedToken>;
};

export type AnimatedTokenName = keyof typeof motion.animated;

/** Wide-typed view of the animated tokens (AnimatedToken interface applies —
 *  used by tests/tooling that inspect optional fields like `ceremonial`). */
export const animatedTokens: Readonly<Record<AnimatedTokenName, AnimatedToken>> =
  motion.animated;

// ---------------------------------------------------------------------------
// Latency — first-class tokens (budgets, enforced by perf tests downstream)
// ---------------------------------------------------------------------------

export const latency = {
  /** Any input must paint visible feedback within this budget. */
  interactionFeedbackMs: 100,
  /** Terminal typing echo p95 (M2 DoD). */
  keystrokeEchoP95Ms: 100,
  /** Command palette: summon keystroke → interactive. */
  paletteOpenMs: 100,
  /** Below this, NO loading indicator may appear (and never a shimmer). */
  spinnerThresholdMs: 300,
  /** Ceremony total wall-clock cap. */
  ceremonyBudgetMs: 1200,
} as const;

// ---------------------------------------------------------------------------
// Command palette — first-class token block
// ---------------------------------------------------------------------------

export const palette = {
  summon: 'Mod+K',
  widthPx: 640,
  offsetYPx: 160,
  rowPx: 28,
  maxRows: 12,
  radius: radius.r2,
  border: `1px solid ${line.emphasis}`,
  scrim: surface.scrim,
} as const;

// ---------------------------------------------------------------------------
// Layout — ultrawide-first three-zone cockpit
// ---------------------------------------------------------------------------

export const layout = {
  zone: {
    /** Left: fleet / workstreams rail. */
    leftPx: 304,
    /** Right: channel instrument stack (fixed slots, see channels). */
    rightPx: 352,
    /** Center: active session — flexible, never below this. */
    centerMinPx: 640,
  },
  breakpoint: {
    /** <compact: single column (laptop fallback). */
    compactPx: 1024,
    /** ≥cockpit: full three-zone cockpit. */
    cockpitPx: 1440,
    /** ≥ultrawide: cockpit + persistent secondary session columns. */
    ultrawidePx: 2200,
  },
} as const;

// ---------------------------------------------------------------------------
// Focus — outline only (shadows do not exist)
// ---------------------------------------------------------------------------

export const focus = {
  outline: `1px solid ${accent.amber}`,
  offset: '1px',
} as const;

// ---------------------------------------------------------------------------
// Aggregate export + helpers
// ---------------------------------------------------------------------------

export const tokens = {
  surface,
  ink,
  accent,
  status,
  channels,
  channelOrder,
  line,
  radius,
  shadow,
  space,
  grid,
  font,
  type,
  tracking,
  numeric,
  motion,
  latency,
  palette,
  layout,
  focus,
} as const;

/** Every hex literal the design system owns (lint/test allowlist source). */
export function allHexValues(): readonly string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.add(m[0].toLowerCase());
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(tokens);
  return [...out].sort();
}

export default tokens;
