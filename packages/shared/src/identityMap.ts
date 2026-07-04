/**
 * Identity → account-label mapping loader [X2].
 *
 * The mapping from real identities (account emails, org/account UUIDs, AWS
 * account ids) to the placeholder labels MAX_A/MAX_B/ENT/AWS_DEV/LOCAL lives
 * ONLY in a machine-local JSON file:
 *
 *     $AIBENDER_HOME/identity-map.json     (default: ~/.aibender/identity-map.json)
 *
 * That file is NEVER committed — the repo ships only a pointer example with
 * empty values at infra/profiles/identity-map.example.json. File format:
 *
 *     {
 *       "$comment": "keys starting with $ are ignored",
 *       "MAX_A":   ["<identity string>", ...],
 *       "MAX_B":   [],
 *       "ENT":     [],
 *       "AWS_DEV": []
 *     }
 *
 * Loader semantics (tested):
 *   - missing file  → empty map, `loaded: false` (mapping degrades; redaction
 *     stays fail-closed — see redaction.ts: unmapped identifiers are REDACTED)
 *   - malformed JSON / unknown label key / non-string identity → throw
 *     IdentityMapError (loud, never silently partial)
 *   - identities are matched after NFC normalization + trim + lowercase
 *   - one identity mapping to two labels is ambiguous → throw
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ACCOUNT_LABELS, type AccountLabel } from '@aibender/protocol';

export class IdentityMapError extends Error {
  override readonly name = 'IdentityMapError';
}

export interface IdentityEntry {
  /** Normalized identity (NFC + trim + lowercase). */
  readonly identity: string;
  readonly label: AccountLabel;
}

export interface IdentityMap {
  /** False when no machine-local file was found (empty map). */
  readonly loaded: boolean;
  /** Absolute path the map came from, when loaded. */
  readonly source: string | undefined;
  readonly size: number;
  /** Label for a raw identity string, if mapped (input is normalized first). */
  labelFor(identity: string): AccountLabel | undefined;
  /** All entries, normalized — feeds the log-line scrubber (redaction.ts). */
  entries(): readonly IdentityEntry[];
}

/** NFC + trim + lowercase: byte-stable matching per blueprint §3 path rules. */
export function normalizeIdentity(identity: string): string {
  return identity.normalize('NFC').trim().toLowerCase();
}

function buildMap(entries: readonly IdentityEntry[], loaded: boolean, source?: string): IdentityMap {
  const byIdentity = new Map<string, AccountLabel>(entries.map((e) => [e.identity, e.label]));
  return {
    loaded,
    source,
    size: byIdentity.size,
    labelFor: (identity: string) =>
      typeof identity === 'string' ? byIdentity.get(normalizeIdentity(identity)) : undefined,
    entries: () => entries,
  };
}

/** An empty map (labelFor always undefined). */
export function emptyIdentityMap(): IdentityMap {
  return buildMap([], false);
}

/**
 * Parse identity-map JSON text. Throws {@link IdentityMapError} on any
 * structural problem — a partially-wrong map must never load quietly.
 */
export function parseIdentityMap(json: string, source?: string): IdentityMap {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new IdentityMapError(
      `identity map${source ? ` at ${source}` : ''} is not valid JSON: ${(cause as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IdentityMapError('identity map must be a JSON object keyed by account label');
  }
  const entries: IdentityEntry[] = [];
  const seen = new Map<string, AccountLabel>();
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue; // comment keys, e.g. "$comment"
    if (!(ACCOUNT_LABELS as readonly string[]).includes(key)) {
      throw new IdentityMapError(
        `unknown label key ${JSON.stringify(key)} (want one of ${ACCOUNT_LABELS.join(', ')}; ` +
          `keys starting with "$" are ignored)`,
      );
    }
    const label = key as AccountLabel;
    if (!Array.isArray(value)) {
      throw new IdentityMapError(`label ${label} must map to an array of identity strings`);
    }
    for (const item of value) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new IdentityMapError(`label ${label} contains a non-string or blank identity entry`);
      }
      const identity = normalizeIdentity(item);
      const existing = seen.get(identity);
      if (existing !== undefined) {
        throw new IdentityMapError(
          `identity maps to two labels (${existing} and ${label}) — ambiguous mapping refused`,
        );
      }
      seen.set(identity, label);
      entries.push({ identity, label });
    }
  }
  return buildMap(entries, true, source);
}

export interface LoadIdentityMapOptions {
  /** Override $AIBENDER_HOME resolution entirely (tests). */
  readonly aibenderHome?: string;
  /** Env source, default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Resolve the machine-local identity-map path (without reading it). */
export function identityMapPath(options: LoadIdentityMapOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.aibenderHome ?? env['AIBENDER_HOME'] ?? join(homedir(), '.aibender');
  return join(home, 'identity-map.json');
}

/**
 * Load the machine-local identity map. Missing file → empty map
 * (`loaded: false`); any other failure throws {@link IdentityMapError}.
 */
export function loadIdentityMap(options: LoadIdentityMapOptions = {}): IdentityMap {
  const path = identityMapPath(options);
  let json: string;
  try {
    json = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return emptyIdentityMap();
    throw new IdentityMapError(`cannot read identity map at ${path}: ${(cause as Error).message}`);
  }
  return parseIdentityMap(json, path);
}
