/**
 * Finalized redaction utilities [X2] (M1 freeze, plan §3).
 *
 * Two surfaces:
 *   1. {@link createRedactionFilter} — the structured-field filter wired into
 *      createLogger. Given schema `secret`/`identifier` tags:
 *        secret      → REDACTED, always (secret wins over any other tag)
 *        identifier  → mapped to its MAX_A/… label when the machine-local
 *                      identity map knows it; REDACTED otherwise (fail-closed)
 *        unknown tag → value passes through unchanged
 *        untagged    → value passes through unchanged
 *   2. {@link createLineScrubber} — raw log-LINE scrubbing for text that never
 *      went through structured logging (child stderr, PTY-adjacent logs,
 *      journals): every known secret VALUE is replaced with [REDACTED], every
 *      known identity VALUE with its label.
 *
 * Matching notes (documented limits, tested):
 *   - identity matching is case-insensitive on the NFC-normalized form;
 *     an identity written in a different Unicode normalization than the map
 *     entry will NOT match — provision maps in NFC.
 *   - patterns are applied longest-first so an identity that contains another
 *     (e.g. an email containing a short org id) cannot shadow it.
 */

import type { IdentityMap } from './identityMap.js';
import { REDACTED, type RedactionFilter } from './tags.js';

export interface RedactionFilterOptions {
  /** Machine-local identity map; absent → every identifier is REDACTED. */
  readonly identityMap?: IdentityMap;
}

/**
 * The finalized M1 redaction filter. See module doc for the exact semantics.
 */
export function createRedactionFilter(options: RedactionFilterOptions = {}): RedactionFilter {
  const identityMap = options.identityMap;
  return ({ value, tags }) => {
    if (tags.has('secret')) return REDACTED;
    if (tags.has('identifier')) {
      if (typeof value === 'string' && identityMap !== undefined) {
        const label = identityMap.labelFor(value);
        if (label !== undefined) return label;
      }
      return REDACTED; // fail-closed: unmapped identifiers never pass
    }
    return value; // untagged and unknown-tagged fields pass through
  };
}

export interface LineScrubberOptions {
  /**
   * Exact secret VALUES known at runtime (e.g. per-boot gateway token,
   * keychain-fetched keys held in memory). Never persist this list.
   */
  readonly secretValues?: readonly string[];
  /** Identities scrub to their label. */
  readonly identityMap?: IdentityMap;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ScrubPattern {
  readonly regex: RegExp;
  readonly replacement: string;
}

/**
 * Build a log-line scrubber. Returns the line with every known secret value
 * replaced by [REDACTED] and every known identity by its account label.
 */
export function createLineScrubber(options: LineScrubberOptions = {}): (line: string) => string {
  const patterns: ScrubPattern[] = [];
  for (const secret of options.secretValues ?? []) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    patterns.push({ regex: new RegExp(escapeRegExp(secret), 'g'), replacement: REDACTED });
  }
  for (const { identity, label } of options.identityMap?.entries() ?? []) {
    if (identity.length === 0) continue;
    patterns.push({ regex: new RegExp(escapeRegExp(identity), 'gi'), replacement: label });
  }
  // Longest-first so containing strings are scrubbed before their substrings.
  patterns.sort((a, b) => b.regex.source.length - a.regex.source.length);
  return (line: string): string => {
    let out = line;
    for (const { regex, replacement } of patterns) {
      out = out.replace(regex, replacement);
    }
    return out;
  };
}
