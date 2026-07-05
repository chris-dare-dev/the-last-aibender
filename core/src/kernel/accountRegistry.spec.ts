/**
 * accountRegistry.spec.ts — the [X1]/ICR-0013 discovered account registry.
 *
 * Proves the mechanism that makes "add a new Claude account" a DATA change:
 * discovery reads `*.profile.json` manifests from a FIXTURE dir (rule 3 — never
 * the real ~/.aibender/accounts/*), validates each label against the OPEN
 * sanctioned form, expands its convention against a synthetic AIBENDER_HOME, and
 * yields the configured labels + pinned byte-stable dirs. A 4th (MAX_C) and 5th
 * (MAX_D) manifest are discovered with zero code change; a non-sanctioned or
 * fixed-backend manifest is refused.
 *
 * All fixtures are placeholder labels only [X2] — MAX_A..MAX_D + ENT are the
 * sanctioned placeholder set; no real identity ever appears here.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { createAccountRegistry, expandConvention } from './accountRegistry.js';
import { ProfileConfigError } from './errors.js';

const HOME = '/synthetic/aibender-home';

const scratchDirs: string[] = [];
function scratchProfilesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibender-acct-registry-'));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write a per-account manifest (SI-2 `*.profile.json` shape) into a dir. */
function writeManifest(
  dir: string,
  fileStem: string,
  label: string,
  options: {
    readonly configConvention?: string;
    readonly securestorageConvention?: string;
    readonly omitEnv?: boolean;
    readonly badJson?: boolean;
  } = {},
): void {
  const path = join(dir, `${fileStem}.profile.json`);
  if (options.badJson === true) {
    writeFileSync(path, '{ not json');
    return;
  }
  const convDefault = `$AIBENDER_HOME/accounts/${fileStem}`;
  const body: Record<string, unknown> = {
    $comment: 'synthesized fixture — placeholder label only [X2]',
    schemaVersion: 1,
    label,
    kind: label === 'ENT' ? 'enterprise' : 'max',
    pathConvention: options.configConvention ?? convDefault,
  };
  if (options.omitEnv !== true) {
    body['env'] = {
      CLAUDE_CONFIG_DIR: options.configConvention ?? convDefault,
      CLAUDE_SECURESTORAGE_CONFIG_DIR:
        options.securestorageConvention ?? options.configConvention ?? convDefault,
    };
  }
  writeFileSync(path, JSON.stringify(body, null, 2));
}

// ---------------------------------------------------------------------------
// Positive — discovery of N accounts
// ---------------------------------------------------------------------------

describe('createAccountRegistry — discovery (positive)', () => {
  it('discovers the seed three (MAX_A/MAX_B/ENT) with pinned convention dirs', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    writeManifest(dir, 'max-b', 'MAX_B');
    writeManifest(dir, 'ent', 'ENT');

    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: HOME });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'ENT']);

    const a = registry.get('MAX_A');
    expect(a?.configDir).toBe(join(HOME, 'accounts', 'max-a'));
    expect(a?.securestorageDir).toBe(join(HOME, 'accounts', 'max-a'));
    expect(a?.backend).toBe('claude_code');
    expect(registry.get('ENT')?.configDir).toBe(join(HOME, 'accounts', 'ent'));
  });

  it('discovers a FOURTH account (MAX_C) with zero code change — just its manifest', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    writeManifest(dir, 'max-b', 'MAX_B');
    writeManifest(dir, 'ent', 'ENT');
    writeManifest(dir, 'max-c', 'MAX_C');

    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: HOME });
    // Max ladder first (A,B,C), ENT last.
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'MAX_C', 'ENT']);
    expect(registry.has('MAX_C')).toBe(true);
    expect(registry.get('MAX_C')?.configDir).toBe(join(HOME, 'accounts', 'max-c'));
    expect(registry.get('MAX_C')?.securestorageDir).toBe(join(HOME, 'accounts', 'max-c'));
  });

  it('discovers a FIFTH account (MAX_D) too — the registry is the single source of truth', () => {
    const dir = scratchProfilesDir();
    for (const [stem, label] of [
      ['max-a', 'MAX_A'],
      ['max-b', 'MAX_B'],
      ['max-c', 'MAX_C'],
      ['max-d', 'MAX_D'],
      ['ent', 'ENT'],
    ] as const) {
      writeManifest(dir, stem, label);
    }
    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: HOME });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'MAX_C', 'MAX_D', 'ENT']);
    expect(registry.all()).toHaveLength(5);
    for (const account of registry.all()) {
      expect(account.backend).toBe('claude_code');
      expect(account.configDir.startsWith(HOME)).toBe(true);
    }
  });

  it('order is deterministic regardless of filesystem/read order (Max ladder, ENT last)', () => {
    const dir = scratchProfilesDir();
    // Write ENT first, then D, C, B, A — discovery order must not leak through.
    writeManifest(dir, 'ent', 'ENT');
    writeManifest(dir, 'max-d', 'MAX_D');
    writeManifest(dir, 'max-c', 'MAX_C');
    writeManifest(dir, 'max-b', 'MAX_B');
    writeManifest(dir, 'max-a', 'MAX_A');
    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: HOME });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'MAX_C', 'MAX_D', 'ENT']);
  });

  it('AIBENDER_HOME comes from the env source when aibenderHome is not passed', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    const registry = createAccountRegistry({
      profilesDir: dir,
      env: { AIBENDER_HOME: '/synthetic/env-home' },
    });
    expect(registry.get('MAX_A')?.configDir).toBe('/synthetic/env-home/accounts/max-a');
  });
});

// ---------------------------------------------------------------------------
// Negative — the form is a REAL gate, not anything-goes
// ---------------------------------------------------------------------------

describe('createAccountRegistry — refusals (negative)', () => {
  it('refuses a fixed-backend label in a profile manifest (AWS_DEV/LOCAL have no config dir)', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'aws-dev', 'AWS_DEV');
    expect(() => createAccountRegistry({ profilesDir: dir, aibenderHome: HOME })).toThrow(
      ProfileConfigError,
    );
    const dir2 = scratchProfilesDir();
    writeManifest(dir2, 'local', 'LOCAL');
    expect(() => createAccountRegistry({ profilesDir: dir2, aibenderHome: HOME })).toThrow(
      /BE-4|adapter|no CLAUDE_CONFIG_DIR/i,
    );
  });

  it('refuses a non-sanctioned label (HACKER, MAX_AB, lowercase max_c, email-shaped)', () => {
    for (const bad of ['HACKER', 'MAX_AB', 'max_c', 'user@example.com']) {
      const dir = scratchProfilesDir();
      writeManifest(dir, 'x', bad);
      expect(() => createAccountRegistry({ profilesDir: dir, aibenderHome: HOME })).toThrow(
        ProfileConfigError,
      );
    }
  });

  it('refuses a manifest whose securestorage dir is decoupled from config dir (the pin)', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A', {
      configConvention: '$AIBENDER_HOME/accounts/max-a',
      securestorageConvention: '$AIBENDER_HOME/accounts/max-a-store',
    });
    expect(() => createAccountRegistry({ profilesDir: dir, aibenderHome: HOME })).toThrow(
      /PINNED/i,
    );
  });

  it('refuses a duplicate label across two manifests (ambiguous)', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    writeManifest(dir, 'max-a-dup', 'MAX_A');
    expect(() => createAccountRegistry({ profilesDir: dir, aibenderHome: HOME })).toThrow(
      /already defined|ambiguous/i,
    );
  });

  it('refuses a convention that does not start with $AIBENDER_HOME/ (no literal machine paths [X2])', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A', { configConvention: '/absolute/literal/path' });
    expect(() => createAccountRegistry({ profilesDir: dir, aibenderHome: HOME })).toThrow(
      ProfileConfigError,
    );
  });

  it('throws loudly on malformed JSON and on a missing env block (never silently partial)', () => {
    const badJsonDir = scratchProfilesDir();
    writeManifest(badJsonDir, 'max-a', 'MAX_A', { badJson: true });
    expect(() => createAccountRegistry({ profilesDir: badJsonDir, aibenderHome: HOME })).toThrow(
      ProfileConfigError,
    );

    const noEnvDir = scratchProfilesDir();
    writeManifest(noEnvDir, 'max-a', 'MAX_A', { omitEnv: true });
    expect(() => createAccountRegistry({ profilesDir: noEnvDir, aibenderHome: HOME })).toThrow(
      /env/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

describe('createAccountRegistry — edge', () => {
  it('an empty/absent profiles dir yields an EMPTY registry (no accounts configured)', () => {
    const emptyDir = scratchProfilesDir();
    const empty = createAccountRegistry({ profilesDir: emptyDir, aibenderHome: HOME });
    expect(empty.labels()).toEqual([]);
    expect(empty.all()).toEqual([]);
    expect(empty.has('MAX_A')).toBe(false);

    const absent = createAccountRegistry({
      profilesDir: join(emptyDir, 'does-not-exist'),
      aibenderHome: HOME,
    });
    expect(absent.labels()).toEqual([]);
  });

  it('ignores non-manifest files in the dir (only *.profile.json is read)', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    writeFileSync(join(dir, 'README.md'), '# not a manifest');
    writeFileSync(join(dir, 'identity-map.example.json'), '{"$comment":"pointer only"}');
    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: HOME });
    expect(registry.labels()).toEqual(['MAX_A']);
  });

  it('NFC-normalizes the expanded dir once (byte-stable for the keychain hash)', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    // café with a decomposed é (NFD) in the home root.
    const nfdHome = '/synthetic/café-home';
    const nfcHome = nfdHome.normalize('NFC');
    expect(nfdHome).not.toBe(nfcHome);
    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: nfdHome });
    const configDir = registry.get('MAX_A')?.configDir ?? '';
    expect(configDir).toBe(join(nfcHome, 'accounts', 'max-a'));
    expect(configDir.normalize('NFC')).toBe(configDir);
  });

  it('the registry and every entry are frozen (byte-stable references)', () => {
    const dir = scratchProfilesDir();
    writeManifest(dir, 'max-a', 'MAX_A');
    const registry = createAccountRegistry({ profilesDir: dir, aibenderHome: HOME });
    expect(Object.isFrozen(registry)).toBe(true);
    const a = registry.get('MAX_A');
    expect(a).toBeDefined();
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('expandConvention mirrors lib.sh: literal $AIBENDER_HOME/ prefix replacement only', () => {
    expect(expandConvention('$AIBENDER_HOME/accounts/max-c', HOME)).toBe(
      join(HOME, 'accounts', 'max-c'),
    );
    expect(() => expandConvention('~/accounts/max-c', HOME)).toThrow(ProfileConfigError);
    expect(() => expandConvention('/literal/path', HOME)).toThrow(ProfileConfigError);
  });
});

// ---------------------------------------------------------------------------
// Integration — the REAL committed infra/profiles/ manifests parse (read-only)
// ---------------------------------------------------------------------------

describe('createAccountRegistry — the committed infra/profiles/ manifests', () => {
  // Repo-relative: core/src/kernel/ → ../../../infra/profiles. These are the
  // SI-2 committed PLACEHOLDER manifests (rule 3: NOT the live ~/.aibender
  // account dirs — we only read the committed convention files, against a
  // synthetic home). Proves the discovery format matches SI's real files, so a
  // freshly `terraform`/provisioned account is discovered with no format drift.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const committedProfilesDir = join(repoRoot, 'infra', 'profiles');

  it('discovers every committed placeholder account against a synthetic home', () => {
    const registry = createAccountRegistry({
      profilesDir: committedProfilesDir,
      aibenderHome: HOME,
    });
    const labels = registry.labels();
    // At least the seed three; the owner may have committed MAX_C/MAX_D too.
    expect(labels).toContain('MAX_A');
    expect(labels).toContain('MAX_B');
    expect(labels).toContain('ENT');
    for (const account of registry.all()) {
      expect(account.backend).toBe('claude_code');
      // Every dir expands under the synthetic home — no literal machine path
      // ever leaked into a committed manifest [X2].
      expect(account.configDir.startsWith(join(HOME, 'accounts'))).toBe(true);
      expect(account.configDir).toBe(account.securestorageDir);
    }
  });
});
