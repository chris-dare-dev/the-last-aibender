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
 * Hygiene [X2]:
 *  - the file carries the per-boot secret → file mode 0600, dir mode 0700,
 *    both enforced with explicit chmod (fs write modes are umask-subject);
 *  - writes are atomic (temp file + rename) so a reader never sees a torn
 *    JSON body;
 *  - removal is ownership-checked: a shutdown only unlinks the file when it
 *    still carries this boot's token, so a stale broker exiting late cannot
 *    delete a newer boot's discovery file.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GatewayBootstrap {
  /** TCP port of the WS server on 127.0.0.1. */
  readonly port: number;
  /** Per-boot auth token (secret — never log). */
  readonly token: string;
  /** Broker process id, for liveness checks by the discovering client. */
  readonly pid: number;
  /** ISO-8601 wall-clock boot time. */
  readonly startedAt: string;
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
  return true;
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

  const temp = join(dir, `.${BOOTSTRAP_FILE_NAME}.${bootstrap.pid}.tmp`);
  const body = `${JSON.stringify(bootstrap, null, 2)}\n`;
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
