/**
 * @aibender/shared — cross-cutting utilities every other package may consume:
 * harness id generation, monotonic clock, structured logging with redaction
 * filters keyed off schema `secret`/`identifier` tags, and the machine-local
 * identity→MAX_A/MAX_B/ENT/AWS_DEV/LOCAL mapping loader (plan §3; owner
 * BE-ORCH; FROZEN at M1 — amendments via ICR, docs/contracts/icr/).
 *
 * [X2]: the identity mapping table loads from $AIBENDER_HOME/identity-map.json
 * (default ~/.aibender/) and is never committed; the repo carries only
 * infra/profiles/identity-map.example.json with empty values.
 */

import { randomUUID } from 'node:crypto';

import { defaultRedactionFilter, type FieldTag, type RedactionFilter, type TaggedField } from './tags.js';

// Re-exports: tag vocabulary + finalized redaction + identity map ------------

export {
  REDACTED,
  defaultRedactionFilter,
  type FieldTag,
  type RedactionFilter,
  type TaggedField,
} from './tags.js';

export {
  createLineScrubber,
  createRedactionFilter,
  type LineScrubberOptions,
  type RedactionFilterOptions,
} from './redaction.js';

export {
  IdentityMapError,
  emptyIdentityMap,
  identityMapPath,
  loadIdentityMap,
  normalizeIdentity,
  parseIdentityMap,
  type IdentityEntry,
  type IdentityMap,
  type LoadIdentityMapOptions,
} from './identityMap.js';

// ---------------------------------------------------------------------------
// Harness ids — harness ids are never native (Claude/OpenCode) ids [X4].
// ---------------------------------------------------------------------------

/** Lowercase alphanumeric/hyphen prefix, 1–16 chars, starting with a letter. */
const ID_PREFIX_RE = /^[a-z][a-z0-9-]{0,15}$/;

/**
 * Generate a harness id: `<prefix>_<32 hex chars>`, e.g. `ws_3f2a…`.
 * The prefix names the entity kind (`ws` workstream, `sn` session node, …).
 */
export function newId(prefix: string): string {
  if (typeof prefix !== 'string' || !ID_PREFIX_RE.test(prefix)) {
    throw new RangeError(
      `invalid id prefix ${JSON.stringify(prefix)} (want ${ID_PREFIX_RE.source})`,
    );
  }
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

// ---------------------------------------------------------------------------
// Monotonic clock
// ---------------------------------------------------------------------------

/**
 * Milliseconds from a monotonic source (never wall-clock; immune to NTP/DST
 * jumps). Use for ordering, watermarks, and durations — never for timestamps
 * persisted across process restarts.
 */
export function monotonicMillis(): number {
  return performance.now();
}

// ---------------------------------------------------------------------------
// Structured logging with redaction (X2)
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly msg: string;
  /** Monotonic ms at emit time (see {@link monotonicMillis}). */
  readonly monotonicMs: number;
  /** Post-redaction fields. Raw tagged values never reach the sink. */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface LoggerOptions {
  /** Where records go. Default: one JSON line per record on stdout. */
  readonly sink?: (record: LogRecord) => void;
  /**
   * Redaction filter. Default: {@link defaultRedactionFilter} (redacts ANY
   * tagged field). Wire createRedactionFilter({ identityMap }) for the
   * finalized identifier→label mapping behavior.
   */
  readonly redact?: RedactionFilter;
  /**
   * Field-name → tags map, sourced from @aibender/schema declarations
   * (e.g. KERNEL_FIELD_TAGS). Fields absent from the map are untagged.
   */
  readonly fieldTags?: Readonly<Record<string, readonly FieldTag[]>>;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const EMPTY_TAGS: ReadonlySet<FieldTag> = new Set();

/**
 * Structured logger. Real transport/rotation lands with the broker (M1+);
 * the redaction contract is frozen NOW and is the part dependents rely on.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink =
    options.sink ?? ((record: LogRecord) => console.log(JSON.stringify(record)));
  const redact = options.redact ?? defaultRedactionFilter;
  const fieldTags = options.fieldTags ?? {};

  const emit = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    const safeFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const tags: ReadonlySet<FieldTag> = fieldTags[key] ? new Set(fieldTags[key]) : EMPTY_TAGS;
      const field: TaggedField = { key, value, tags };
      safeFields[key] = redact(field);
    }
    sink({ level, msg, monotonicMs: monotonicMillis(), fields: safeFields });
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
