/**
 * Profile registry (BE-1, plan §4/BE-1; blueprint §3).
 *
 * Resolves an account label to the per-account directory pair the spawn layer
 * injects:
 *
 *     label → { configDir, securestorageDir }
 *
 * Sources, in precedence order (later wins):
 *   1. Built-in conventions mirroring plan §2's machine-local layout:
 *      `$AIBENDER_HOME/accounts/{max-a,max-b,ent}/`
 *   2. An SI-2 profile manifest (committed under `infra/profiles/`, labels +
 *      dir-name conventions ONLY — never real identity [X2]). Passed in as a
 *      parsed object or a path; absent file → built-in conventions stand.
 *   3. Machine-local overrides at `$AIBENDER_HOME/profiles.json` (absolute
 *      real paths; NEVER committed [X2]).
 *
 * PATH DISCIPLINE (blueprint §3 rule 2, x1 findings): the keychain service
 * name is derived from the sha256 of the RAW config-dir string, so paths are
 * NFC-normalized exactly ONCE — at profile load — and are byte-stable
 * absolute strings thereafter. `resolve()` returns the same frozen object
 * (identical string references) on every call.
 *
 * SCOPE: this registry covers the three Claude subscription labels
 * (MAX_A/MAX_B/ENT). AWS_DEV rides the OpenCode adapter and LOCAL rides the
 * LM Studio adapter (BE-4, M2–M3) — neither has a CLAUDE_CONFIG_DIR, and
 * resolving them here is refused with a typed error. Unknown labels are
 * refused likewise (plan §9.2 BE-1 negative row).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  isClaudeAccountLabel,
  isFixedBackendLabel,
  type AccountLabel,
  type ClaudeAccountLabel,
} from '@aibender/protocol';

import {
  createAccountRegistry,
  type AccountRegistry,
  type AccountRegistryOptions,
} from './accountRegistry.js';
import { ProfileConfigError, UnknownProfileError } from './errors.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The KNOWN/SEED profile labels — the three originally provisioned Claude
 * accounts. This is a back-compat + seeding + test convenience matching
 * {@link DEFAULT_PROFILES_MANIFEST}; it is NO LONGER the validation ceiling
 * (ICR-0013). A newly provisioned Max account (`MAX_C`, `MAX_D`, …) is a
 * first-class profile label by FORM ({@link isClaudeProfileLabel}) the moment
 * its manifest/override/registry entry exists — no code change here.
 */
export const CLAUDE_PROFILE_LABELS = Object.freeze(['MAX_A', 'MAX_B', 'ENT'] as const);

/**
 * A Claude subscription profile label: the OPEN, validated account FORM
 * ({@link isClaudeAccountLabel} — `MAX_<X>` for a single uppercase letter, or
 * the exact literal `ENT`). This is the SAME form the wire/schema validate; it
 * deliberately EXCLUDES the fixed backend labels `AWS_DEV`/`LOCAL` (which have
 * no CLAUDE_CONFIG_DIR and ride the BE-4 adapters).
 */
export type ClaudeProfileLabel = ClaudeAccountLabel;

/**
 * True for a Claude subscription profile label. Keys off the OPEN account FORM
 * (ICR-0013), not membership in {@link CLAUDE_PROFILE_LABELS} — so `MAX_C` /
 * `MAX_D` / … pass without a code change. `AWS_DEV`/`LOCAL` and any
 * non-sanctioned string are rejected.
 */
export function isClaudeProfileLabel(value: unknown): value is ClaudeProfileLabel {
  return isClaudeAccountLabel(value);
}

/** A resolved per-account profile. Both paths are absolute, NFC, frozen. */
export interface ClaudeProfile {
  readonly label: ClaudeProfileLabel;
  readonly backend: 'claude_code';
  /** Byte-stable absolute CLAUDE_CONFIG_DIR string. */
  readonly configDir: string;
  /**
   * Byte-stable absolute CLAUDE_SECURESTORAGE_CONFIG_DIR string. Pinned to
   * configDir unless a machine-local override deliberately decouples them
   * (the Desktop-style shared-store pattern; x1 findings §a′).
   */
  readonly securestorageDir: string;
}

// ---------------------------------------------------------------------------
// SI-2 manifest (committed; labels + dir-name conventions only)
// ---------------------------------------------------------------------------

/**
 * Parsed SI-2 aggregate-manifest shape (see infra/profiles/; placeholders only
 * [X2]). Keys are sanctioned Claude account labels validated by FORM at parse
 * time (ICR-0013) — `MAX_C`/`MAX_D`/… are admitted without a code change. This
 * aggregate `{ accounts: { LABEL: { dirName } } }` shape is the registry's
 * dir-name override input; the per-account `*.profile.json` discovery format
 * lives in accountRegistry.ts.
 */
export interface ProfilesManifest {
  readonly accounts: Readonly<Record<string, { readonly dirName: string }>>;
}

/** Built-in conventions = plan §2 machine-local layout. */
export const DEFAULT_PROFILES_MANIFEST: ProfilesManifest = Object.freeze({
  accounts: Object.freeze({
    MAX_A: Object.freeze({ dirName: 'max-a' }),
    MAX_B: Object.freeze({ dirName: 'max-b' }),
    ENT: Object.freeze({ dirName: 'ent' }),
  }),
});

/** Parse SI-2 manifest JSON text. Throws {@link ProfileConfigError} loudly. */
export function parseProfilesManifest(json: string, source?: string): ProfilesManifest {
  const where = source ? ` at ${source}` : '';
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ProfileConfigError(
      `profile manifest${where} is not valid JSON: ${(cause as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProfileConfigError(`profile manifest${where} must be a JSON object`);
  }
  const accountsRaw = (raw as Record<string, unknown>)['accounts'];
  if (typeof accountsRaw !== 'object' || accountsRaw === null || Array.isArray(accountsRaw)) {
    throw new ProfileConfigError(`profile manifest${where} must carry an "accounts" object`);
  }
  const accounts: Record<string, { dirName: string }> = {};
  for (const [key, value] of Object.entries(accountsRaw)) {
    if (key.startsWith('$')) continue; // comment keys
    if (!isClaudeProfileLabel(key)) {
      throw new ProfileConfigError(
        `profile manifest${where} has non-sanctioned label key ${JSON.stringify(key)} ` +
          '(want a Claude account: MAX_<X> where X is a single uppercase letter, or ENT [X2])',
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ProfileConfigError(`profile manifest${where}: label ${key} must map to an object`);
    }
    const dirName = (value as Record<string, unknown>)['dirName'];
    if (typeof dirName !== 'string' || dirName.trim().length === 0) {
      throw new ProfileConfigError(
        `profile manifest${where}: label ${key} needs a non-blank string "dirName"`,
      );
    }
    if (dirName.includes('/') || dirName.includes('\\') || isAbsolute(dirName)) {
      throw new ProfileConfigError(
        `profile manifest${where}: label ${key} dirName must be a bare directory name ` +
          '(machine-local roots come from $AIBENDER_HOME, never the manifest [X2])',
      );
    }
    accounts[key] = { dirName };
  }
  return { accounts };
}

// ---------------------------------------------------------------------------
// Machine-local overrides ($AIBENDER_HOME/profiles.json; never committed)
// ---------------------------------------------------------------------------

interface ProfileOverride {
  readonly configDir: string;
  readonly securestorageDir?: string;
}

function parseOverrides(json: string, source: string): Record<string, ProfileOverride> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ProfileConfigError(
      `profile overrides at ${source} are not valid JSON: ${(cause as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProfileConfigError(`profile overrides at ${source} must be a JSON object`);
  }
  const out: Record<string, ProfileOverride> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    if (!isClaudeProfileLabel(key)) {
      throw new ProfileConfigError(
        `profile overrides at ${source}: non-sanctioned label key ${JSON.stringify(key)} ` +
          '(want a Claude account: MAX_<X> where X is a single uppercase letter, or ENT [X2])',
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ProfileConfigError(`profile overrides at ${source}: ${key} must map to an object`);
    }
    const record = value as Record<string, unknown>;
    const configDir = record['configDir'];
    if (typeof configDir !== 'string' || !isAbsolute(configDir)) {
      throw new ProfileConfigError(
        `profile overrides at ${source}: ${key}.configDir must be an absolute path string`,
      );
    }
    const securestorageDir = record['securestorageDir'];
    if (securestorageDir !== undefined && (typeof securestorageDir !== 'string' || !isAbsolute(securestorageDir))) {
      throw new ProfileConfigError(
        `profile overrides at ${source}: ${key}.securestorageDir must be an absolute path string when present`,
      );
    }
    out[key] = {
      configDir,
      ...(securestorageDir !== undefined ? { securestorageDir } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProfileRegistry {
  /** The labels this registry can resolve. */
  labels(): readonly ClaudeProfileLabel[];
  /**
   * Resolve a label to its profile. Returns the SAME frozen object on every
   * call (byte-stable strings). Unknown labels — including the non-Claude
   * account labels AWS_DEV/LOCAL — throw {@link UnknownProfileError}.
   */
  resolve(label: AccountLabel | string): ClaudeProfile;
}

export interface ProfileRegistryOptions {
  /** Override $AIBENDER_HOME resolution entirely (tests). */
  readonly aibenderHome?: string;
  /** Env source for AIBENDER_HOME, default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Parsed SI-2 aggregate manifest. Wins over `manifestPath`. */
  readonly manifest?: ProfilesManifest;
  /** Path to an SI-2 aggregate manifest JSON file. Missing file → built-in defaults. */
  readonly manifestPath?: string;
  /**
   * Machine-local overrides file. Default `$AIBENDER_HOME/profiles.json`.
   * Missing file → no overrides. Malformed file → loud ProfileConfigError.
   */
  readonly overridesPath?: string;
  /**
   * The discovered account registry ([X1]/ICR-0013). When present, EVERY
   * account it discovered from `infra/profiles/*.profile.json` is registered
   * here with its pinned dirs — so `MAX_C`/`MAX_D`/… resolve the moment their
   * manifest exists, with ZERO code change. This is the single source of "which
   * accounts exist"; the seed labels + aggregate manifest remain for
   * back-compat and only fill gaps the registry did not cover.
   */
  readonly accountRegistry?: AccountRegistry;
  /**
   * Options to BUILD the account registry when {@link accountRegistry} is not
   * passed directly. Convenience for composition (`{ profilesDir }`). Ignored
   * when `accountRegistry` is supplied.
   */
  readonly accountRegistryOptions?: AccountRegistryOptions;
}

/** Resolve the machine-local aibender home (mirrors @aibender/shared). */
export function aibenderHomePath(options: ProfileRegistryOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.aibenderHome ?? env['AIBENDER_HOME'] ?? join(homedir(), '.aibender');
  if (!isAbsolute(home)) {
    throw new ProfileConfigError(
      'AIBENDER_HOME must be an absolute path (byte-stable strings, blueprint §3 rule 2)',
    );
  }
  return home;
}

/** NFC-normalize once at load; callers get byte-stable strings forever. */
function nfc(path: string): string {
  return path.normalize('NFC');
}

/**
 * Default bare dir-name for a Claude account label, mirroring plan §2's layout:
 * `MAX_A` → `max-a`, `MAX_C` → `max-c`, `ENT` → `ent`. This is the same
 * `label.toLowerCase().replaceAll('_','-')` rule the SI provisioning scripts
 * use, so a Max account beyond the seed gets a sensible convention dir with no
 * manifest edit — the aggregate manifest / override still wins when present.
 */
export function defaultDirNameFor(label: ClaudeProfileLabel): string {
  return label.toLowerCase().replaceAll('_', '-');
}

/**
 * Build the profile registry. All path normalization happens HERE, once;
 * everything downstream (env injection, keychain-name math in SI-2 scripts)
 * sees identical byte-stable strings.
 *
 * The label set is OPEN (ICR-0013): the registry serves every account it can
 * source a dir for — the seed labels (MAX_A/MAX_B/ENT) ALWAYS, plus any account
 * introduced by the discovered {@link AccountRegistry}, the aggregate manifest,
 * or a machine-local override. A `MAX_C`/`MAX_D`/… therefore resolves the
 * moment its `*.profile.json` manifest exists — NO code change (that is the
 * whole [X1] point). Labels the registry cannot source a dir for still throw
 * {@link UnknownProfileError} on resolve, so the gate stays real.
 */
export function createProfileRegistry(options: ProfileRegistryOptions = {}): ProfileRegistry {
  const home = aibenderHomePath(options);

  let manifest = options.manifest;
  if (manifest === undefined && options.manifestPath !== undefined) {
    if (existsSync(options.manifestPath)) {
      manifest = parseProfilesManifest(
        readFileSync(options.manifestPath, 'utf8'),
        options.manifestPath,
      );
    }
  }
  manifest ??= DEFAULT_PROFILES_MANIFEST;

  const overridesPath = options.overridesPath ?? join(home, 'profiles.json');
  let overrides: Record<string, ProfileOverride> = {};
  if (existsSync(overridesPath)) {
    overrides = parseOverrides(readFileSync(overridesPath, 'utf8'), overridesPath);
  }

  // The discovered account registry ([X1]): passed directly, or built from
  // accountRegistryOptions, or — when neither is given — an EMPTY registry so
  // back-compat callers keep the seed-only behavior.
  const accountRegistry =
    options.accountRegistry ??
    (options.accountRegistryOptions !== undefined
      ? createAccountRegistry({
          ...options.accountRegistryOptions,
          ...(options.accountRegistryOptions.aibenderHome === undefined &&
          options.aibenderHome !== undefined
            ? { aibenderHome: options.aibenderHome }
            : {}),
          ...(options.accountRegistryOptions.env === undefined && options.env !== undefined
            ? { env: options.env }
            : {}),
        })
      : undefined);

  // The label set to register: seed ∪ manifest ∪ overrides ∪ discovered. Order:
  // seed first (stable back-compat labels()), then any additional in code-unit
  // order for determinism.
  const seed = CLAUDE_PROFILE_LABELS as readonly ClaudeProfileLabel[];
  const extra = new Set<ClaudeProfileLabel>();
  for (const key of Object.keys(manifest.accounts)) {
    if (isClaudeProfileLabel(key) && !seed.includes(key)) extra.add(key);
  }
  for (const key of Object.keys(overrides)) {
    if (isClaudeProfileLabel(key) && !seed.includes(key)) extra.add(key);
  }
  for (const label of accountRegistry?.labels() ?? []) {
    if (!seed.includes(label)) extra.add(label);
  }
  const orderedLabels: ClaudeProfileLabel[] = [...seed, ...[...extra].sort()];

  const profiles = new Map<ClaudeProfileLabel, ClaudeProfile>();
  for (const label of orderedLabels) {
    const override = overrides[label];
    const discovered = accountRegistry?.get(label);
    // Dir precedence: machine-local override > discovered manifest > aggregate
    // manifest dirName > default convention dir. securestorage follows suit,
    // pinned to config unless an override deliberately decouples it.
    const dirName = manifest.accounts[label]?.dirName ?? defaultDirNameFor(label);
    const configDir = nfc(
      override?.configDir ?? discovered?.configDir ?? join(home, 'accounts', dirName),
    );
    const securestorageDir = nfc(
      override?.securestorageDir ?? discovered?.securestorageDir ?? configDir,
    );
    profiles.set(
      label,
      Object.freeze({ label, backend: 'claude_code' as const, configDir, securestorageDir }),
    );
  }

  const labels = Object.freeze(orderedLabels);
  return {
    labels: () => labels,
    resolve: (label) => {
      if (isFixedBackendLabel(label)) {
        throw new UnknownProfileError(
          label,
          'not a Claude subscription profile — AWS_DEV/LOCAL sessions ride the BE-4 adapters (M2–M3)',
        );
      }
      const profile = isClaudeProfileLabel(label) ? profiles.get(label) : undefined;
      if (profile === undefined) throw new UnknownProfileError(String(label));
      return profile;
    },
  };
}
