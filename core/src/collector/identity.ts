/**
 * [X2] identity handling AT INGEST (blueprint §6.2; plan §4/BE-5): identity
 * attributes are DROPPED or MAPPED TO LABELS before anything reaches the
 * events store — the store's own insert screen (@aibender/schema
 * `assertIdentityFreeColumn`) is the backstop that THROWS; this module is the
 * collector-side scrubber that makes sure the backstop never fires on real
 * ingest, because the identity-shaped content was already removed.
 *
 * Two mechanisms:
 *   1. KEY-BASED DROP: OTel/hook attribute keys that BY NAME carry identity
 *      ({@link IDENTITY_ATTRIBUTE_KEYS}: user.email, user.account_uuid,
 *      organization.id, …) are deleted wholesale at ingest. Account
 *      attribution comes ONLY from the harness-stamped `account=<LABEL>`
 *      resource attribute / watch-root label / URL path segment.
 *   2. SHAPE-BASED SCRUB: free-text values are swept for identity shapes
 *      (email addresses, 12-digit AWS-account-id runs, token-shaped strings)
 *      and matches are replaced with {@link IDENTITY_DROPPED}.
 *
 * Detector regexes only — no literal identity values live in this file.
 */

// ---------------------------------------------------------------------------
// Shape detectors (aligned with @aibender/schema + testkit jsonl.ts)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TWELVE_DIGIT_RE = /\d{12,}/g;
const TOKEN_SHAPED_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;

/** Replacement marker for scrubbed identity-shaped content. */
export const IDENTITY_DROPPED = '[identity-dropped]';

/**
 * Attribute keys dropped wholesale at ingest (case-insensitive, dot/underscore
 * agnostic): identity attribution never enters any store, per-account labels
 * come from the harness-controlled channel only [X2].
 */
export const IDENTITY_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  'user.email',
  'user.id',
  'user.account_uuid',
  'user.account-uuid',
  'organization.id',
  'organization.uuid',
  'user.uuid',
  'account.uuid',
  'terminal.type', // benign but machine-profiling; not needed by any lead
]);

const NORMALIZED_IDENTITY_KEYS = new Set(
  IDENTITY_ATTRIBUTE_KEYS.map((key) => key.toLowerCase().replaceAll('_', '.')),
);

/** True when an attribute key is identity-bearing BY NAME and must be dropped. */
export function isIdentityAttributeKey(key: string): boolean {
  return NORMALIZED_IDENTITY_KEYS.has(key.toLowerCase().replaceAll('_', '.'));
}

/**
 * Replace identity-shaped substrings (emails, 12+-digit runs, token-shaped
 * strings) with {@link IDENTITY_DROPPED}. Total: never throws on any input.
 *
 * NOTE the 12-digit detector here is deliberately `\d{12,}` (12 OR MORE):
 * a scrubbed column can then never contain a 12-digit window at all. Columns
 * that legitimately carry long digit runs (epoch-ms inside raw_ref /
 * facets_json) are NOT scrubbed with this — they are `identifier`-tagged in
 * EVENTS_FIELD_TAGS and audited with the word-bounded audit regex instead.
 */
export function scrubIdentityText(text: string): string {
  return text
    .replace(EMAIL_RE, IDENTITY_DROPPED)
    .replace(TOKEN_SHAPED_RE, IDENTITY_DROPPED)
    .replace(TWELVE_DIGIT_RE, IDENTITY_DROPPED);
}

/**
 * Deep-scrub a JSON-ish value: identity-bearing KEYS dropped, string values
 * shape-scrubbed, arrays/objects walked. Non-JSON values pass through.
 */
export function scrubIdentityDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubIdentityText(value);
  if (Array.isArray(value)) return value.map(scrubIdentityDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isIdentityAttributeKey(key)) continue; // dropped at ingest [X2]
      out[scrubIdentityText(key)] = scrubIdentityDeep(entry);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Audit sweep (THE [X2] audit uses these; exported so the spec and any later
// live audit query share one detector set)
// ---------------------------------------------------------------------------

/**
 * Audit detectors for STORED TEXT values. The 12-digit detector is
 * word-bounded here: epoch-ms values (13 digits today) inside identifier-
 * tagged columns are legitimate and must not trip the audit, while an exact
 * 12-digit token (AWS-account-id shaped) always does.
 */
export const AUDIT_DETECTORS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['email shape', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  ['12-digit id shape', /\b\d{12}\b/],
  ['token shape', /\bsk-[A-Za-z0-9_-]{8,}/],
]);

/** Names of identity shapes found in `text` (empty = clean). */
export function findIdentityShapes(text: string): readonly string[] {
  const hits: string[] = [];
  for (const [what, re] of AUDIT_DETECTORS) {
    if (re.test(text)) hits.push(what);
  }
  return hits;
}
