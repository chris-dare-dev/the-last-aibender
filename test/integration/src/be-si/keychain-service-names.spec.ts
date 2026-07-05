/**
 * §9.3 BE↔SI #2 (synthetic half) — SI-2-provisioned config dirs → BE-1 spawn
 * env → the EXPECTED per-config-dir keychain SERVICE NAMES.
 *
 * This is NAME COMPUTATION ONLY — no keychain is read or written (the live
 * `security find-generic-password` / `auth status --json` halves are T3,
 * enumerated in live-check, asserted by the meta-test). The seam proven here:
 *   1. BE-1's createProfileRegistry, pointed at a synthetic $AIBENDER_HOME
 *      laid out like SI-2's provisioning, resolves each account's
 *      CLAUDE_SECURESTORAGE_CONFIG_DIR;
 *   2. buildSessionEnv injects that exact byte-stable string;
 *   3. the keychain service name SI-2 computes from that string
 *      (infra/scripts/accounts/lib.sh `aib_service_name`:
 *      `<serviceBase>-<first 8 hex of sha256(NFC(dir))>`) is REPRODUCED here
 *      independently and asserted BYTE-EQUAL to the real shell function's
 *      output for the SAME dir.
 *
 * Because both accounts pin CLAUDE_CONFIG_DIR === CLAUDE_SECURESTORAGE_CONFIG_DIR
 * (blueprint §3), the three accounts yield three DISTINCT service-name suffixes
 * — the M1 acceptance clause "keychain shows three distinct suffixed items",
 * proven at the name-computation level.
 *
 * [X2]: synthetic $AIBENDER_HOME under a temp dir; labels only; no identity.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSessionEnv,
  createProfileRegistry,
  type ClaudeProfileLabel,
} from '../../../../core/src/kernel/index.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB_SH = join(REPO_ROOT, 'infra/scripts/accounts/lib.sh');
const SERVICE_BASE = 'Claude Code-credentials';
const LABELS: readonly ClaudeProfileLabel[] = ['MAX_A', 'MAX_B', 'ENT'];

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

/** The SI-2 derivation, reimplemented in TS (the anti-drift baseline). */
function expectedServiceName(securestorageDir: string): string {
  const nfc = securestorageDir.normalize('NFC');
  const hash8 = createHash('sha256').update(nfc, 'utf8').digest('hex').slice(0, 8);
  return `${SERVICE_BASE}-${hash8}`;
}

/** The REAL SI-2 shell function `aib_service_name` (sourced from lib.sh). */
async function shellServiceName(securestorageDir: string): Promise<string> {
  const script = `
    set -euo pipefail
    . "${LIB_SH}"
    aib_service_name "$1"
  `;
  const { stdout } = await execFileAsync('bash', ['-c', script, 'bash', securestorageDir]);
  return stdout.trim();
}

/** Provision a synthetic SI-2-shaped home: accounts/{max-a,max-b,ent}. */
async function provision(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), 'aibender-integ-si2-'));
  for (const dir of ['max-a', 'max-b', 'ent']) {
    await mkdir(join(home, 'accounts', dir), { recursive: true });
  }
  return home;
}

describe('BE↔SI #2 — BE-1 spawn env dir → SI-2 keychain service name (name computation)', () => {
  it('BE-1 spawn env carries the pinned config + securestorage dirs per account', async () => {
    const homeDir = await provision();
    const registry = createProfileRegistry({ aibenderHome: homeDir });

    for (const label of LABELS) {
      const profile = registry.resolve(label);
      const env = buildSessionEnv(profile, { baseEnv: {} });
      // The byte-stable dir strings BE-1 injects (blueprint §3 rule 2).
      expect(env['CLAUDE_CONFIG_DIR']).toBe(profile.configDir);
      expect(env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(profile.securestorageDir);
      // Pinned equal (blueprint §3) — SI-2's serviceNameRule hashes the
      // securestorage dir, which equals the config dir.
      expect(profile.securestorageDir).toBe(profile.configDir);
      // And the dir lives under the SI-2 pathConvention layout.
      expect(profile.configDir.startsWith(join(homeDir, 'accounts'))).toBe(true);
    }
  });

  it('the TS-computed service name equals SI-2 lib.sh aib_service_name byte-for-byte', async () => {
    const homeDir = await provision();
    const registry = createProfileRegistry({ aibenderHome: homeDir });

    for (const label of LABELS) {
      const dir = registry.resolve(label).securestorageDir;
      const ours = expectedServiceName(dir);
      const shell = await shellServiceName(dir);
      expect(shell, `${label}: SI-2 shell derivation must match the spawn-env dir`).toBe(ours);
      // Shape: base + '-' + 8 lowercase hex.
      expect(ours).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    }
  });

  it('the three accounts yield three DISTINCT service-name suffixes (M1 acceptance)', async () => {
    const homeDir = await provision();
    const registry = createProfileRegistry({ aibenderHome: homeDir });
    const names = LABELS.map((label) => expectedServiceName(registry.resolve(label).securestorageDir));
    expect(new Set(names).size).toBe(3);
  });

  it('a version-gate drift (dir string changes) recomputes to a DIFFERENT service name', async () => {
    // The version-gate guard: if an SDK bump changed the dir the SDK hashes,
    // the recomputed service name would drift — detectable by comparison.
    const homeDir = await provision();
    const registry = createProfileRegistry({ aibenderHome: homeDir });
    const base = registry.resolve('MAX_A').securestorageDir;
    const drifted = `${base}-v2`; // simulate a scoping change
    expect(expectedServiceName(drifted)).not.toBe(expectedServiceName(base));
    // And the shell agrees the drift is detectable.
    expect(await shellServiceName(drifted)).not.toBe(await shellServiceName(base));
  });
});
