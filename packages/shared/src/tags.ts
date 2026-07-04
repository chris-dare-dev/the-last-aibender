/**
 * Field-tag vocabulary + the redaction-filter contract [X2].
 *
 * @aibender/schema declares `secret` / `identifier` tags on its columns
 * (e.g. KERNEL_FIELD_TAGS); loggers and scrubbers in this package key off
 * them. Tags are open-ended strings: the two known tags drive redaction,
 * anything else passes through untouched (forward-compatible with future
 * schema tags — see createRedactionFilter in redaction.ts).
 */

/**
 * `secret` → value must never be emitted; `identifier` → value is mapped to a
 * MAX_A/MAX_B/ENT/AWS_DEV/LOCAL label or redacted. Unknown tags are legal and
 * do not trigger redaction by the finalized filter.
 */
export type FieldTag = 'secret' | 'identifier' | (string & {});

export interface TaggedField {
  readonly key: string;
  readonly value: unknown;
  readonly tags: ReadonlySet<FieldTag>;
}

/**
 * THE redaction-filter signature (plan §3). Given a field and its schema tags,
 * return what may be emitted. Filters are total: they see every field, tagged
 * or not, so they can also do heuristic scrubbing later.
 */
export type RedactionFilter = (field: TaggedField) => unknown;

export const REDACTED = '[REDACTED]' as const;

/**
 * Fail-safe default: anything tagged AT ALL is replaced. Stricter than the
 * finalized identity-aware filter (createRedactionFilter) — kept as the
 * default so a logger wired without an identity map can never leak.
 */
export const defaultRedactionFilter: RedactionFilter = ({ value, tags }) =>
  tags.size > 0 ? REDACTED : value;
