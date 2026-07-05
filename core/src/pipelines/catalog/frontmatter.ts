/**
 * The ONE merged-frontmatter parser (BE-8; findings pipeline-workflow-builder
 * §1.1/§1.8/§R1). Claude skills and commands are the SAME feature with the
 * SAME frontmatter (§1.2 "one parser handles both"), so a single parser feeds
 * every catalog consumer.
 *
 * TWO NON-NEGOTIABLE ROBUSTNESS RULES (the DoD names both):
 *   1. UNKNOWN-KEY PRESERVATION — the scanner must tolerate the Obsidian-style
 *      user keys (`type`, `status`, `tags`, `model-class`, …) real projects
 *      carry (§1.8 local ground truth). Every parsed key survives verbatim in
 *      the returned record; the scanner NEVER drops a key it does not know.
 *   2. MALFORMED-YAML SURVIVAL — Claude Code itself, on a broken frontmatter
 *      block, "loads the body with empty metadata (`/name` still works, no
 *      description)" (§1.1). This parser MUST do the same: a malformed block
 *      yields `{ ok: false }` with the body still extracted, so the scanner
 *      surfaces a DEGRADED catalog row (filename-derived name, no description)
 *      rather than crashing the whole scan.
 *
 * DELIBERATELY HAND-ROLLED, no `js-yaml`: the frontmatter dialect the surfaces
 * use is a tiny, well-bounded subset (scalars, quoted strings, block/flow
 * lists, booleans) — a full YAML engine is both a runtime dependency in a
 * public repo and an attack surface (anchors/tags/merge keys) the catalog does
 * not want. Anything this subset cannot represent is preserved as its RAW
 * string value (never lost, never mis-typed) — the invocation surface the
 * palette needs only reads the handful of known scalar/list fields anyway
 * (findings §R1: "the parsed frontmatter is deliberately not on the wire").
 *
 * [X2]: this parser reads machine-local files and returns their content as-is;
 * the identity screen lives at the wire (the DAG validator's naming screen and
 * the catalog record projection), never here — a SKILL.md body legitimately
 * carries paths.
 */

/** A parsed frontmatter value: the tiny dialect the surfaces actually use. */
export type FrontmatterValue = string | number | boolean | readonly string[];

/** The parsed frontmatter map — unknown keys preserved verbatim. */
export type Frontmatter = Readonly<Record<string, FrontmatterValue>>;

export interface FrontmatterParseOk {
  readonly ok: true;
  /** Every key from the block, unknown keys included. */
  readonly frontmatter: Frontmatter;
  /** The markdown body after the closing `---`. */
  readonly body: string;
}

export interface FrontmatterParseDegraded {
  readonly ok: false;
  /**
   * Why the block was rejected (identifier-free — a parser diagnostic, never
   * a file path). The scanner turns this into a degraded catalog row.
   */
  readonly reason: string;
  /** The body is still recovered so `/name` (filename) invocation stays live. */
  readonly body: string;
}

export type FrontmatterParseResult = FrontmatterParseOk | FrontmatterParseDegraded;

const FENCE = '---';

/**
 * Parse a `---`-delimited YAML frontmatter block from a markdown document.
 *
 * - No opening fence → `{ ok: true, frontmatter: {}, body: <whole doc> }`
 *   (a bodyless-metadata document is legal; the whole file is the body).
 * - Opening fence with no closing fence → DEGRADED (`unterminated block`),
 *   body = everything after the opening fence (Claude Code's "load the body"
 *   behavior).
 * - A frontmatter LINE the subset cannot parse → DEGRADED for the WHOLE block
 *   (matches Claude Code: a broken block yields empty metadata, not a
 *   partially-parsed one) — but the body is always recovered.
 */
export function parseFrontmatter(source: string): FrontmatterParseResult {
  // Normalize newlines; a BOM would otherwise defeat the opening-fence check.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // The opening fence must be the very first line (leading blank lines are not
  // frontmatter — Claude Code requires the block at the top).
  if (lines[0]?.trim() !== FENCE) {
    return { ok: true, frontmatter: {}, body: text };
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FENCE) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    // Unterminated: recover the body (everything after the opening fence).
    return { ok: false, reason: 'unterminated frontmatter block', body: lines.slice(1).join('\n') };
  }

  const bodyLines = lines.slice(closeIndex + 1);
  // Drop a single leading blank line between the fence and the body (cosmetic).
  if (bodyLines[0] === '') bodyLines.shift();
  const body = bodyLines.join('\n');

  const blockLines = lines.slice(1, closeIndex);
  const parsed = parseBlock(blockLines);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, body };
  return { ok: true, frontmatter: parsed.frontmatter, body };
}

// ---------------------------------------------------------------------------
// Block parsing (the bounded subset)
// ---------------------------------------------------------------------------

type BlockResult =
  | { readonly ok: true; readonly frontmatter: Frontmatter }
  | { readonly ok: false; readonly reason: string };

function parseBlock(blockLines: readonly string[]): BlockResult {
  const out: Record<string, FrontmatterValue> = {};
  let i = 0;
  while (i < blockLines.length) {
    const rawLine = blockLines[i] ?? '';
    i += 1;
    // Blank lines and full-line comments are ignored.
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // A frontmatter line is `key: value` (indentation is not part of the
    // subset — nested maps are not a surface we invoke, so a leading-space
    // line is a malformed block for our purposes).
    if (/^\s/.test(rawLine)) {
      return { ok: false, reason: 'unexpected indentation (nested maps unsupported)' };
    }
    const colon = rawLine.indexOf(':');
    if (colon === -1) {
      return { ok: false, reason: 'frontmatter line is not `key: value`' };
    }
    const key = rawLine.slice(0, colon).trim();
    if (key.length === 0 || /\s/.test(key)) {
      return { ok: false, reason: 'malformed frontmatter key' };
    }
    // Strip an inline comment ONLY when the value is unquoted (a `#` inside a
    // quoted string is data).
    const rawValue = rawLine.slice(colon + 1).trim();

    if (rawValue.length === 0) {
      // Either an empty scalar or the header of a block list. Peek ahead for
      // `- item` lines.
      const listItems: string[] = [];
      while (i < blockLines.length) {
        const peek = blockLines[i] ?? '';
        const peekTrimmed = peek.trim();
        if (peekTrimmed.startsWith('- ') || peekTrimmed === '-') {
          const item = peekTrimmed === '-' ? '' : peekTrimmed.slice(2).trim();
          listItems.push(unquoteScalar(item));
          i += 1;
          continue;
        }
        break;
      }
      out[key] = listItems.length > 0 ? Object.freeze([...listItems]) : '';
      continue;
    }

    out[key] = parseScalarOrFlowList(rawValue);
  }
  return { ok: true, frontmatter: Object.freeze(out) };
}

/** Parse a scalar value or an inline `[a, b, c]` flow list. */
function parseScalarOrFlowList(raw: string): FrontmatterValue {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return Object.freeze([] as readonly string[]);
    const items = splitFlowList(inner).map((part) => unquoteScalar(part.trim()));
    return Object.freeze(items);
  }
  return coerceScalar(raw);
}

/** Split a flow-list body on top-level commas (respecting quotes). */
function splitFlowList(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Coerce an unquoted scalar to boolean/number where unambiguous, else string. */
function coerceScalar(raw: string): FrontmatterValue {
  // Strip a trailing inline comment on unquoted scalars only.
  const value = stripInlineComment(raw).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Integers/floats — but NOT strings that merely start with a digit and carry
  // other chars (versions like `2.1.196`, ids). Number() of those is NaN, so
  // the isFinite check keeps them as strings.
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return unquoteScalar(value);
}

/** Remove an unquoted inline `# comment` (a `#` preceded by whitespace). */
function stripInlineComment(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) return raw;
  const hashAt = raw.search(/\s#/);
  return hashAt === -1 ? raw : raw.slice(0, hashAt);
}

/** Remove matching surrounding quotes; leave everything else verbatim. */
function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Typed reads over the parsed map (consumers use these — never index directly,
// so a user key shaped like a known key can never be silently mis-typed).
// ---------------------------------------------------------------------------

/** Read a frontmatter field as a string, when it IS a string. */
export function readString(fm: Frontmatter, key: string): string | undefined {
  const value = fm[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read a frontmatter field as a boolean, when it IS a boolean. */
export function readBoolean(fm: Frontmatter, key: string): boolean | undefined {
  const value = fm[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Read a field as a string list. Accepts a YAML list OR a
 * space/comma-separated string (the `allowed-tools` / `arguments` dual form,
 * §1.1). Empty result → undefined.
 */
export function readStringList(fm: Frontmatter, key: string): readonly string[] | undefined {
  const value = fm[key];
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string' && value.length > 0) {
    const items = value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}
