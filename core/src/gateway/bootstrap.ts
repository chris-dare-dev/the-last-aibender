/**
 * Gateway bootstrap/discovery file (BE-3 M1 slice).
 *
 * The frontend discovers the per-boot WS endpoint by reading
 * `$AIBENDER_HOME/bootstrap/gateway.json` (default `~/.aibender/bootstrap/`,
 * plan §2 machine-local layout). M1 shape (the prose contract
 * docs/contracts/bootstrap-file.md freezes at M2):
 *
 *   { "port": 49152, "token": "<base64url>", "pid": 12345,
 *     "startedAt": "2026-07-04T00:00:00.000Z" }
 *
 * ICR-0014 (2026-07-05) adds ONE optional additive field, `claudeAccounts` —
 * the [X1]/ICR-0013 account-registry carrier picked by BE-ORCH:
 *
 *   { …, "claudeAccounts": ["MAX_A", "MAX_B", "ENT", "MAX_C", "MAX_D"] }
 *
 * It advertises the SANCTIONED PLACEHOLDER labels the broker discovered from
 * `infra/profiles/*.profile.json` so the FE cockpit enumerates the accounts
 * ACTUALLY provisioned on this machine (N accounts, never a hardcoded five).
 * The FE runs in the WKWebView bundle and cannot read the profile manifests
 * itself; this list is the only account information it needs, and it is a
 * PLACEHOLDER-ONLY list — no email/name/id, no machine-local path [X2]. The
 * field is OPTIONAL: absent (M1–M6 files, or a broker with no configured
 * accounts) means exactly "no configured set advertised" and the FE falls
 * back to its seed set. The boot-identity triple (token/pid/startedAt) is
 * UNCHANGED — `claudeAccounts` is not part of it (bootstrap-file.md §2).
 *
 * Hygiene [X2]:
 *  - the file carries the per-boot secret → file mode 0600, dir mode 0700,
 *    both enforced with explicit chmod (fs write modes are umask-subject);
 *  - writes are atomic (temp file + rename) so a reader never sees a torn
 *    JSON body;
 *  - removal is ownership-checked: a shutdown only unlinks the file when it
 *    still carries this boot's token, so a stale broker exiting late cannot
 *    delete a newer boot's discovery file;
 *  - `claudeAccounts` is sanitized FAIL-CLOSED on write: only sanctioned
 *    `MAX_<X>`/`ENT` labels survive ({@link sanitizeClaudeAccountsForBootstrap}),
 *    deduped and order-stable, so the writer can NEVER leak a raw identity even
 *    if a caller hands it garbage.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isClaudeAccountLabel } from '@aibender/protocol';

export interface GatewayBootstrap {
  /** TCP port of the WS server on 127.0.0.1. */
  readonly port: number;
  /** Per-boot auth token (secret — never log). */
  readonly token: string;
  /** Broker process id, for liveness checks by the discovering client. */
  readonly pid: number;
  /** ISO-8601 wall-clock boot time. */
  readonly startedAt: string;
  /**
   * OPTIONAL (ICR-0014): the sanctioned placeholder labels of the Claude
   * accounts this broker discovered from `infra/profiles/*.profile.json` — the
   * [X1] account-registry carrier. Advertises `MAX_<X>`/`ENT` FORM labels ONLY,
   * never a real identity or a machine-local path [X2]. Absent means "no
   * configured set advertised" (FE falls back to its seed set); the field is
   * NOT part of the boot-identity triple.
   */
  readonly claudeAccounts?: readonly string[];
}

export interface BootstrapPathOptions {
  /** Override $AIBENDER_HOME resolution entirely (tests). */
  readonly aibenderHome?: string;
  /** Environment to consult (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const BOOTSTRAP_FILE_NAME = 'gateway.json';

export const BOOTSTRAP_FILE_MODE = 0o600;
export const BOOTSTRAP_DIR_MODE = 0o700;

/** `$AIBENDER_HOME` → `~/.aibender` (mirrors @aibender/shared identityMap resolution). */
export function resolveAibenderHome(options: BootstrapPathOptions = {}): string {
  const env = options.env ?? process.env;
  return options.aibenderHome ?? env['AIBENDER_HOME'] ?? join(homedir(), '.aibender');
}

export function bootstrapDir(options: BootstrapPathOptions = {}): string {
  return join(resolveAibenderHome(options), 'bootstrap');
}

export function bootstrapPath(options: BootstrapPathOptions = {}): string {
  return join(bootstrapDir(options), BOOTSTRAP_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Validation (total over unknown — a torn/foreign file must never throw)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural validation of a parsed bootstrap body. */
export function isGatewayBootstrap(value: unknown): value is GatewayBootstrap {
  if (!isRecord(value)) return false;
  const port = value['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const token = value['token'];
  if (typeof token !== 'string' || token.length === 0) return false;
  const pid = value['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return false;
  const startedAt = value['startedAt'];
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return false;
  // ICR-0014: `claudeAccounts` is OPTIONAL. Absent is valid (back-compat with
  // every M1–M6 file). Present must be an array of strings — a foreign
  // non-array or a non-string element makes the WHOLE file "no broker
  // advertised" (the reader never partially trusts a torn/foreign body). The
  // per-element FORM check ([X2]) is enforced on WRITE (sanitize) and again by
  // the FE reader; the structural validator only pins array-of-strings so a
  // valid boot with sanitized labels is not rejected.
  const claudeAccounts = value['claudeAccounts'];
  if (claudeAccounts !== undefined) {
    if (!Array.isArray(claudeAccounts)) return false;
    if (!claudeAccounts.every((entry) => typeof entry === 'string')) return false;
  }
  return true;
}

/**
 * Sanitize a configured Claude-account label list for the bootstrap carrier,
 * FAIL-CLOSED per [X2]. Keeps only sanctioned `MAX_<X>`/`ENT` FORM labels
 * ({@link isClaudeAccountLabel}), de-duplicated and order-stable (first-seen).
 * A raw identity (email, real name, AWS id), a fixed-backend label
 * (`AWS_DEV`/`LOCAL` are NOT Claude accounts), `MAX_AB`, lowercase `max_c`, or
 * any non-string never survives — so the broker can never advertise anything
 * but placeholders. Returns `undefined` (the field is OMITTED) when nothing
 * survives, so a broker with no configured accounts writes a byte-identical
 * M1–M6-shaped file.
 */
export function sanitizeClaudeAccountsForBootstrap(
  configured: Iterable<unknown> | undefined,
): readonly string[] | undefined {
  if (configured === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of configured) {
    if (!isClaudeAccountLabel(value)) continue; // [X2] drop non-form input
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? Object.freeze(out) : undefined;
}

// ---------------------------------------------------------------------------
// Write / read / remove
// ---------------------------------------------------------------------------

/**
 * Atomically write the bootstrap file with 0600/0700 permissions enforced.
 * Returns the absolute path written.
 */
export async function writeBootstrapFile(
  bootstrap: GatewayBootstrap,
  options: BootstrapPathOptions = {},
): Promise<string> {
  if (!isGatewayBootstrap(bootstrap)) {
    throw new RangeError('refusing to write a malformed gateway bootstrap body');
  }
  const dir = bootstrapDir(options);
  const target = join(dir, BOOTSTRAP_FILE_NAME);
  await mkdir(dir, { recursive: true, mode: BOOTSTRAP_DIR_MODE });
  // mkdir's mode only applies on creation — enforce on every write.
  await chmod(dir, BOOTSTRAP_DIR_MODE);

  // ICR-0014: sanitize the carrier FAIL-CLOSED [X2]. Only sanctioned labels
  // land on disk; an empty result OMITS the field so a no-accounts broker
  // writes an M1–M6-shaped file (the boot identity is untouched either way).
  const claudeAccounts = sanitizeClaudeAccountsForBootstrap(bootstrap.claudeAccounts);
  const persisted: GatewayBootstrap = {
    port: bootstrap.port,
    token: bootstrap.token,
    pid: bootstrap.pid,
    startedAt: bootstrap.startedAt,
    ...(claudeAccounts !== undefined ? { claudeAccounts } : {}),
  };

  const temp = join(dir, `.${BOOTSTRAP_FILE_NAME}.${bootstrap.pid}.tmp`);
  const body = `${JSON.stringify(persisted, null, 2)}\n`;
  await writeFile(temp, body, { encoding: 'utf8', mode: BOOTSTRAP_FILE_MODE });
  // writeFile's mode is umask-subject — enforce, then publish atomically.
  await chmod(temp, BOOTSTRAP_FILE_MODE);
  await rename(temp, target);
  return target;
}

/**
 * Read and validate the bootstrap file. Returns undefined when the file is
 * absent, unreadable, or malformed — discovery treats all three as
 * "no broker advertised".
 */
export async function readBootstrapFile(
  options: BootstrapPathOptions = {},
): Promise<GatewayBootstrap | undefined> {
  let raw: string;
  try {
    raw = await readFile(bootstrapPath(options), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isGatewayBootstrap(parsed)) return undefined;
  return {
    port: parsed.port,
    token: parsed.token,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    // ICR-0014: preserve the carrier when present (re-sanitized on the read
    // side too — defence in depth; a torn/foreign element already made the
    // whole body fail isGatewayBootstrap above). Omitted when absent/empty so
    // the returned object matches an M1–M6 body exactly.
    ...(parsed.claudeAccounts !== undefined
      ? (() => {
          const labels = sanitizeClaudeAccountsForBootstrap(parsed.claudeAccounts);
          return labels !== undefined ? { claudeAccounts: labels } : {};
        })()
      : {}),
  };
}

/**
 * Remove the bootstrap file iff it still belongs to this boot (token match).
 * Returns true when the file was removed, false when it was absent, foreign,
 * or unreadable (all left untouched).
 */
export async function removeBootstrapFile(
  expectedToken: string,
  options: BootstrapPathOptions = {},
): Promise<boolean> {
  const current = await readBootstrapFile(options);
  if (current === undefined || current.token !== expectedToken) return false;
  try {
    await rm(bootstrapPath(options));
    return true;
  } catch {
    return false;
  }
}
