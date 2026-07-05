/**
 * Account registry (BE-core, [X1] scalability / ICR-0013).
 *
 * THE SINGLE SOURCE OF "WHICH CLAUDE ACCOUNTS EXIST ON THIS MACHINE."
 *
 * The set of Claude subscription accounts the harness knows about is
 * DISCOVERED — never hardcoded. It is read from the per-account profile
 * manifests SI-2 commits under `infra/profiles/*.profile.json` (the SAME glob +
 * shape the `infra/scripts/accounts/*.sh` tools consume — one file per account,
 * `.label` + `.env.CLAUDE_CONFIG_DIR` + `.env.CLAUDE_SECURESTORAGE_CONFIG_DIR`,
 * path conventions starting with the literal `$AIBENDER_HOME/`). Adding a newly
 * provisioned Max account (`MAX_C`, `MAX_D`, …) is therefore a DATA change —
 * drop in its manifest — with ZERO code change: the keychain isolation already
 * scales automatically (distinct CLAUDE_CONFIG_DIR → distinct securestorage
 * sha256 → distinct keychain item), so the only thing that was hardcoded was
 * this label set. It no longer is.
 *
 * Two concepts stay separate (vocab.ts / ICR-0013):
 *   - CLAUDE ACCOUNT LABELS — an OPEN, validated FORM ({@link
 *     isClaudeAccountLabel}: `^MAX_[A-Z]$` or the exact literal `ENT`). This
 *     registry admits any manifest whose `.label` matches the form.
 *   - FIXED BACKEND LABELS — `AWS_DEV` / `LOCAL`. NOT accounts; each rides a
 *     BE-4 adapter and has NO CLAUDE_CONFIG_DIR. A manifest carrying one of
 *     those labels is REFUSED here (they are not Claude subscription profiles).
 *
 * [X2]: manifests carry LABELS + machine-local path CONVENTIONS only — never a
 * real identity. This loader reads no credential value and never touches the
 * live `~/.aibender/accounts/*` state (it expands the convention string only).
 *
 * PATH DISCIPLINE (blueprint §3 rule 2): the keychain service name is the
 * sha256 of the RAW config-dir string, so the expanded path is NFC-normalized
 * exactly ONCE, here at load, and is a byte-stable absolute string thereafter —
 * identical to how `createProfileRegistry` and `aib_expand_convention` (lib.sh)
 * expand it. All three MUST agree byte-for-byte or the account silently "logs
 * out".
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  ENTERPRISE_ACCOUNT_LABEL,
  isClaudeAccountLabel,
  isFixedBackendLabel,
  type ClaudeAccountLabel,
} from '@aibender/protocol';

import { ProfileConfigError } from './errors.js';
import { aibenderHomePath, type ProfileRegistryOptions } from './profiles.js';

/** The `*.profile.json` suffix SI-2 uses (mirrors `aib_profile_files`). */
export const PROFILE_MANIFEST_SUFFIX = '.profile.json';

/**
 * A discovered account entry: the sanctioned Claude label plus the byte-stable
 * absolute dirs the spawn layer injects. `configDir` and `securestorageDir` are
 * PINNED equal (blueprint §3) unless a machine-local override deliberately
 * decouples them — but a COMMITTED manifest may never decouple them (the SI
 * scripts refuse it too), so this loader enforces the pin.
 */
export interface DiscoveredAccount {
  readonly label: ClaudeAccountLabel;
  readonly backend: 'claude_code';
  /** Byte-stable absolute CLAUDE_CONFIG_DIR (expanded, NFC, once). */
  readonly configDir: string;
  /** Byte-stable absolute CLAUDE_SECURESTORAGE_CONFIG_DIR (== configDir). */
  readonly securestorageDir: string;
  /** The manifest file this entry was discovered from (diagnostics only). */
  readonly source: string;
}

/** The discovered account registry: the machine's configured Claude accounts. */
export interface AccountRegistry {
  /** The configured labels, deterministic (LC_ALL=C) order. */
  labels(): readonly ClaudeAccountLabel[];
  /** True iff `label` was discovered on this machine. */
  has(label: string): boolean;
  /** Lookup, or `undefined` when the label was not discovered. */
  get(label: string): DiscoveredAccount | undefined;
  /** All discovered accounts, deterministic order. */
  all(): readonly DiscoveredAccount[];
}

export interface AccountRegistryOptions {
  /**
   * Directory holding the `*.profile.json` manifests. Defaults to
   * `infra/profiles/` resolved from {@link profilesDir} — tests point this at a
   * FIXTURE dir (rule 3: never the real dir).
   */
  readonly profilesDir?: string;
  /**
   * Override $AIBENDER_HOME resolution (tests). Convention strings expand
   * against this canonical home, exactly like {@link createProfileRegistry}.
   */
  readonly aibenderHome?: string;
  /** Env source for AIBENDER_HOME resolution, default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * When true (default), a manifest carrying a NON-sanctioned or fixed-backend
   * `.label` throws {@link ProfileConfigError}. Set false only in a diagnostic
   * survey that wants to skip-and-continue (still never SILENTLY admits one).
   */
  readonly strict?: boolean;
}

// ---------------------------------------------------------------------------
// Convention expansion (mirrors lib.sh aib_expand_convention, byte-for-byte)
// ---------------------------------------------------------------------------

const HOME_PREFIX = '$AIBENDER_HOME/';

/**
 * Expand a manifest path convention against the canonical home. LITERAL prefix
 * replacement ONLY — the convention string `$AIBENDER_HOME/...` is the
 * contract (infra/profiles/README.md; lib.sh `aib_expand_convention`). Anything
 * that does not start with the literal prefix is refused.
 */
export function expandConvention(convention: string, home: string): string {
  if (!convention.startsWith(HOME_PREFIX)) {
    throw new ProfileConfigError(
      `profile manifest path convention must start with "${HOME_PREFIX}" ` +
        `(machine-local roots come from $AIBENDER_HOME, never a literal path [X2]); got ${JSON.stringify(convention)}`,
    );
  }
  return join(home, convention.slice(HOME_PREFIX.length));
}

/** NFC-normalize once at load (the CLI hashes raw bytes; keep them byte-stable). */
function nfc(path: string): string {
  return path.normalize('NFC');
}

// ---------------------------------------------------------------------------
// Manifest parse (one file → one DiscoveredAccount)
// ---------------------------------------------------------------------------

interface ParsedManifest {
  readonly label: string;
  readonly configConvention: string;
  readonly securestorageConvention: string;
}

function parseOneManifest(json: string, source: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ProfileConfigError(
      `profile manifest ${source} is not valid JSON: ${(cause as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProfileConfigError(`profile manifest ${source} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  const label = obj['label'];
  if (typeof label !== 'string' || label.length === 0) {
    throw new ProfileConfigError(`profile manifest ${source}: missing/invalid string ".label"`);
  }

  const env = obj['env'];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new ProfileConfigError(`profile manifest ${source}: missing "env" object`);
  }
  const envObj = env as Record<string, unknown>;

  const configConvention = envObj['CLAUDE_CONFIG_DIR'];
  if (typeof configConvention !== 'string' || configConvention.length === 0) {
    throw new ProfileConfigError(
      `profile manifest ${source}: missing ".env.CLAUDE_CONFIG_DIR" string`,
    );
  }
  const securestorageConvention = envObj['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
  if (typeof securestorageConvention !== 'string' || securestorageConvention.length === 0) {
    throw new ProfileConfigError(
      `profile manifest ${source}: missing ".env.CLAUDE_SECURESTORAGE_CONFIG_DIR" string`,
    );
  }
  return { label, configConvention, securestorageConvention };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Default `infra/profiles/` directory. Resolved from `AIBENDER_PROFILES_DIR`
 * when set (SI parity), else the repo-relative committed manifests dir.
 *
 * NOTE: composition and tests pass an explicit {@link AccountRegistryOptions.profilesDir}.
 * This default exists so a zero-arg call still points somewhere sane; it never
 * reaches into `~/.aibender` (rule 3).
 */
export function defaultProfilesDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicit = env['AIBENDER_PROFILES_DIR'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return undefined;
}

/**
 * Build the account registry by discovering `*.profile.json` manifests. This is
 * the [X1] mechanism: adding an account is adding its manifest — no code change.
 *
 * - Manifests are read in deterministic (LC_ALL=C-equivalent) order, matching
 *   `aib_profile_files`, so `labels()`/`all()` are stable across runs.
 * - Every `.label` is validated against the sanctioned Claude FORM. A fixed
 *   backend label (`AWS_DEV`/`LOCAL`) is refused with a pointer at the BE-4
 *   adapters; any other non-form label is refused as non-sanctioned [X2].
 * - The securestorage convention MUST equal the config convention (the pin;
 *   lib.sh refuses a decoupled committed manifest too).
 * - A duplicate label across two manifests is refused (ambiguous).
 * - A missing/empty profiles dir yields an EMPTY registry (no accounts
 *   configured) — callers decide whether that is fatal.
 */
export function createAccountRegistry(options: AccountRegistryOptions = {}): AccountRegistry {
  const env = options.env ?? process.env;
  const home = aibenderHomePath({
    ...(options.aibenderHome !== undefined ? { aibenderHome: options.aibenderHome } : {}),
    env,
  } as ProfileRegistryOptions);
  const strict = options.strict ?? true;
  const dir = options.profilesDir ?? defaultProfilesDir(env);

  const accounts = new Map<ClaudeAccountLabel, DiscoveredAccount>();

  if (dir === undefined || !existsSync(dir)) {
    return freezeRegistry(accounts);
  }

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(PROFILE_MANIFEST_SUFFIX))
    .sort(); // Array.sort default is code-unit order == LC_ALL=C for ASCII names

  for (const name of files) {
    const source = join(dir, name);
    const parsed = parseOneManifest(readFileSync(source, 'utf8'), source);

    if (!isClaudeAccountLabel(parsed.label)) {
      if (isFixedBackendLabel(parsed.label)) {
        if (strict) {
          throw new ProfileConfigError(
            `profile manifest ${source}: label ${JSON.stringify(parsed.label)} is a FIXED BACKEND ` +
              'label, not a Claude subscription account — AWS_DEV/LOCAL ride the BE-4 adapters, ' +
              'they have no CLAUDE_CONFIG_DIR and belong in no profile manifest',
          );
        }
        continue;
      }
      if (strict) {
        throw new ProfileConfigError(
          `profile manifest ${source}: label ${JSON.stringify(parsed.label)} is not a sanctioned ` +
            'Claude account form (want MAX_<X> where X is a single uppercase letter, or ENT) [X2]',
        );
      }
      continue;
    }
    const label = parsed.label as ClaudeAccountLabel;

    if (parsed.configConvention !== parsed.securestorageConvention) {
      throw new ProfileConfigError(
        `profile manifest ${source}: CLAUDE_SECURESTORAGE_CONFIG_DIR must be PINNED equal to ` +
          'CLAUDE_CONFIG_DIR (blueprint §3) — a committed manifest may never decouple them',
      );
    }

    if (accounts.has(label)) {
      throw new ProfileConfigError(
        `profile manifest ${source}: label ${label} is already defined by another manifest ` +
          '(ambiguous — one manifest per account)',
      );
    }

    const configDir = nfc(expandConvention(parsed.configConvention, home));
    if (!isAbsolute(configDir)) {
      // Unreachable while home is absolute (aibenderHomePath enforces it) and
      // the convention starts with $AIBENDER_HOME/, but assert it explicitly:
      // the byte-stable-absolute contract is load-bearing for the keychain hash.
      throw new ProfileConfigError(
        `profile manifest ${source}: expanded config dir must be absolute (byte-stable, blueprint §3 rule 2)`,
      );
    }
    accounts.set(label, {
      label,
      backend: 'claude_code',
      configDir,
      securestorageDir: configDir,
      source,
    });
  }

  return freezeRegistry(accounts);
}

function freezeRegistry(accounts: Map<ClaudeAccountLabel, DiscoveredAccount>): AccountRegistry {
  // Deterministic order: ENT last so the Max ladder (A,B,C,…) reads first, then
  // the enterprise account — mirrors ACCOUNT_LABELS' seed order intent while
  // staying open. Within Max accounts, code-unit order (A<B<C…).
  const ordered = [...accounts.values()].sort((a, b) => {
    const aEnt = a.label === ENTERPRISE_ACCOUNT_LABEL;
    const bEnt = b.label === ENTERPRISE_ACCOUNT_LABEL;
    if (aEnt !== bEnt) return aEnt ? 1 : -1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  const frozen = Object.freeze(ordered.map((a) => Object.freeze(a)));
  const labels = Object.freeze(frozen.map((a) => a.label));
  return Object.freeze({
    labels: () => labels,
    has: (label: string) => accounts.has(label as ClaudeAccountLabel),
    get: (label: string) => accounts.get(label as ClaudeAccountLabel),
    all: () => frozen,
  });
}
