/**
 * FE-5 skill launcher composition (plan §5/FE-5, feature 3 M2 slice).
 *
 * `/skill-name args` free-text composition with validation. The BE-8 skill
 * catalog does not exist until M5, so:
 *   - validation is SHAPE-ONLY by default (name charset + length caps);
 *   - the CATALOG PICKER SLOT is designed now ({@link SkillCatalogSlot}):
 *     when a catalog implementation is plugged in, unknown skill names become
 *     validation errors and the view renders a picker; until then the slot
 *     reports "no catalog" and the composer stays free-text with a dimmed
 *     NO SIGNAL catalog instrument (DESIGN.md §2.4 — never an error state).
 *
 * A composed skill launch rides the FROZEN launch verb: the composition
 * becomes `LaunchParams.prompt` (`/name args`), substrate `sdk` — no new wire
 * surface is needed (ws-protocol.md §4.1).
 */

/**
 * Skill name: lowercase kebab segments, optionally one `plugin:skill`
 * namespace separator — matches the harness skill naming convention. 1–64
 * chars per segment.
 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})?$/;

/** Composed prompt length cap — keeps a fat paste from becoming a launch. */
export const MAX_SKILL_ARGS_CHARS = 4096;

export interface SkillInvocation {
  /** Validated skill name (no leading slash). */
  readonly name: string;
  /** Raw argument text after the name; absent when none given. */
  readonly args?: string;
}

export type SkillParseIssue =
  | 'empty'
  | 'missing-slash'
  | 'bad-name'
  | 'args-too-long'
  | 'unknown-skill';

export type SkillParseResult =
  | { readonly ok: true; readonly value: SkillInvocation }
  | { readonly ok: false; readonly issue: SkillParseIssue };

// ---------------------------------------------------------------------------
// Catalog picker slot (M5 seam, designed now)
// ---------------------------------------------------------------------------

export interface SkillCatalogEntry {
  readonly name: string;
  readonly summary?: string;
}

/**
 * The picker slot. `list()` returns `undefined` while no catalog exists
 * (free-text mode); a real catalog (BE-8, M5) returns entries and thereby
 * switches the composer to catalog-validated mode without a UI rewrite.
 */
export interface SkillCatalogSlot {
  list(): readonly SkillCatalogEntry[] | undefined;
}

/** The M2 slot: no catalog — free-text validation only. */
export const FREE_TEXT_CATALOG_SLOT: SkillCatalogSlot = Object.freeze({
  list: () => undefined,
});

// ---------------------------------------------------------------------------
// Parse / compose
// ---------------------------------------------------------------------------

/**
 * Parse `/skill-name args` free text. Leading whitespace tolerated; the
 * slash is required; args are everything after the first whitespace run,
 * kept verbatim (trailing-trimmed). With a catalog present, unknown names
 * are refused (`unknown-skill`); without one, shape rules only.
 */
export function parseSkillCommand(
  text: string,
  catalog: SkillCatalogSlot = FREE_TEXT_CATALOG_SLOT,
): SkillParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, issue: 'empty' };
  if (!trimmed.startsWith('/')) return { ok: false, issue: 'missing-slash' };

  const body = trimmed.slice(1);
  const spaceAt = body.search(/\s/);
  const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
  const rawArgs = spaceAt === -1 ? '' : body.slice(spaceAt + 1).trim();

  if (!SKILL_NAME_RE.test(name)) return { ok: false, issue: 'bad-name' };
  if (rawArgs.length > MAX_SKILL_ARGS_CHARS) return { ok: false, issue: 'args-too-long' };

  const entries = catalog.list();
  if (entries !== undefined && !entries.some((e) => e.name === name)) {
    return { ok: false, issue: 'unknown-skill' };
  }

  return {
    ok: true,
    value: rawArgs.length > 0 ? { name, args: rawArgs } : { name },
  };
}

/** Compose the launch prompt: `/name` or `/name args` (single space). */
export function composeSkillPrompt(invocation: SkillInvocation): string {
  if (!SKILL_NAME_RE.test(invocation.name)) {
    throw new RangeError(`invalid skill name ${JSON.stringify(invocation.name)}`);
  }
  const args = invocation.args?.trim();
  return args !== undefined && args.length > 0
    ? `/${invocation.name} ${args}`
    : `/${invocation.name}`;
}

/** Terse per-issue readout text (instrument voice — no marketing verbs). */
export function skillIssueReadout(issue: SkillParseIssue): string {
  switch (issue) {
    case 'empty':
      return 'ENTER /skill-name';
    case 'missing-slash':
      return 'MUST START WITH /';
    case 'bad-name':
      return 'BAD SKILL NAME';
    case 'args-too-long':
      return `ARGS OVER ${String(MAX_SKILL_ARGS_CHARS)} CHARS`;
    case 'unknown-skill':
      return 'NOT IN CATALOG';
  }
}
