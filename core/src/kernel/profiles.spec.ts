import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createAccountRegistry } from './accountRegistry.js';
import {
  CLAUDE_PROFILE_LABELS,
  aibenderHomePath,
  createProfileRegistry,
  defaultDirNameFor,
  isClaudeProfileLabel,
  parseProfilesManifest,
} from './profiles.js';
import { ProfileConfigError, UnknownProfileError } from './errors.js';

const scratchRoots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibender-profiles-'));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

describe('profile registry (BE-1; blueprint §3)', () => {
  // -- positive --------------------------------------------------------------

  it('resolves the three Claude labels to plan-§2 convention dirs under AIBENDER_HOME', () => {
    const home = '/synthetic/aibender-home';
    const registry = createProfileRegistry({ aibenderHome: home });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    expect(registry.resolve('MAX_A').configDir).toBe(join(home, 'accounts', 'max-a'));
    expect(registry.resolve('MAX_B').configDir).toBe(join(home, 'accounts', 'max-b'));
    expect(registry.resolve('ENT').configDir).toBe(join(home, 'accounts', 'ent'));
  });

  it('pins securestorageDir to configDir (blueprint §3: same per-account path)', () => {
    const registry = createProfileRegistry({ aibenderHome: '/synthetic/home' });
    for (const label of CLAUDE_PROFILE_LABELS) {
      const profile = registry.resolve(label);
      expect(profile.securestorageDir).toBe(profile.configDir);
      expect(profile.backend).toBe('claude_code');
    }
  });

  it('honors an SI-2 manifest dirName over the built-in convention', () => {
    const manifest = parseProfilesManifest(
      JSON.stringify({ accounts: { MAX_A: { dirName: 'primary-max' } } }),
    );
    const registry = createProfileRegistry({ aibenderHome: '/synthetic/home', manifest });
    expect(registry.resolve('MAX_A').configDir).toBe('/synthetic/home/accounts/primary-max');
    // Labels absent from the manifest fall back to the built-in convention.
    expect(registry.resolve('ENT').configDir).toBe('/synthetic/home/accounts/ent');
  });

  it('applies machine-local overrides from $AIBENDER_HOME/profiles.json', () => {
    const home = scratch();
    writeFileSync(
      join(home, 'profiles.json'),
      JSON.stringify({
        $comment: 'synthesized fixture',
        MAX_B: { configDir: '/synthetic/custom/max-b-store' },
      }),
    );
    const registry = createProfileRegistry({ aibenderHome: home });
    expect(registry.resolve('MAX_B').configDir).toBe('/synthetic/custom/max-b-store');
    expect(registry.resolve('MAX_B').securestorageDir).toBe('/synthetic/custom/max-b-store');
    expect(registry.resolve('MAX_A').configDir).toBe(join(home, 'accounts', 'max-a'));
  });

  it('lets an override decouple securestorageDir (shared-store pattern, x1 §a′)', () => {
    const home = scratch();
    writeFileSync(
      join(home, 'profiles.json'),
      JSON.stringify({
        ENT: {
          configDir: '/synthetic/ent/workstream-1',
          securestorageDir: '/synthetic/ent/store',
        },
      }),
    );
    const registry = createProfileRegistry({ aibenderHome: home });
    expect(registry.resolve('ENT').configDir).toBe('/synthetic/ent/workstream-1');
    expect(registry.resolve('ENT').securestorageDir).toBe('/synthetic/ent/store');
  });

  it('resolves AIBENDER_HOME from the env source when not overridden', () => {
    const path = aibenderHomePath({ env: { AIBENDER_HOME: '/synthetic/env-home' } });
    expect(path).toBe('/synthetic/env-home');
  });

  // -- negative ---------------------------------------------------------------

  it('refuses unknown labels with a typed error', () => {
    const registry = createProfileRegistry({ aibenderHome: '/synthetic/home' });
    expect(() => registry.resolve('MAX_C')).toThrow(UnknownProfileError);
    expect(() => registry.resolve('')).toThrow(UnknownProfileError);
  });

  it('refuses the non-Claude account labels, pointing at the BE-4 adapters', () => {
    const registry = createProfileRegistry({ aibenderHome: '/synthetic/home' });
    expect(() => registry.resolve('AWS_DEV')).toThrow(/BE-4/);
    expect(() => registry.resolve('LOCAL')).toThrow(UnknownProfileError);
  });

  it('rejects manifests with unknown labels, path-y dirNames, or bad JSON', () => {
    expect(() =>
      parseProfilesManifest(JSON.stringify({ accounts: { AWS_DEV: { dirName: 'x' } } })),
    ).toThrow(ProfileConfigError);
    expect(() =>
      parseProfilesManifest(JSON.stringify({ accounts: { MAX_A: { dirName: '../escape' } } })),
    ).toThrow(ProfileConfigError);
    expect(() =>
      parseProfilesManifest(JSON.stringify({ accounts: { MAX_A: { dirName: '/abs/path' } } })),
    ).toThrow(ProfileConfigError);
    expect(() => parseProfilesManifest('not json')).toThrow(ProfileConfigError);
    expect(() => parseProfilesManifest(JSON.stringify({ nope: true }))).toThrow(
      ProfileConfigError,
    );
  });

  it('rejects malformed override files loudly (never silently partial)', () => {
    const home = scratch();
    writeFileSync(join(home, 'profiles.json'), JSON.stringify({ MAX_A: { configDir: 'rel' } }));
    expect(() => createProfileRegistry({ aibenderHome: home })).toThrow(ProfileConfigError);

    writeFileSync(join(home, 'profiles.json'), JSON.stringify({ NOPE: { configDir: '/x' } }));
    expect(() => createProfileRegistry({ aibenderHome: home })).toThrow(ProfileConfigError);
  });

  it('rejects a relative AIBENDER_HOME (byte-stable absolute strings only)', () => {
    expect(() => createProfileRegistry({ aibenderHome: 'relative/home' })).toThrow(
      ProfileConfigError,
    );
  });

  // -- edge -------------------------------------------------------------------

  it('NFC-normalizes non-NFC path input ONCE at load; byte-stable thereafter', () => {
    // "café" with a decomposed é (e + U+0301) — NFD input.
    const nfdHome = '/synthetic/cafe\u0301-home';
    const nfcHome = nfdHome.normalize('NFC');
    expect(nfdHome).not.toBe(nfcHome); // the fixture really is denormalized

    const registry = createProfileRegistry({ aibenderHome: nfdHome });
    const first = registry.resolve('MAX_A');
    expect(first.configDir).toBe(join(nfcHome, 'accounts', 'max-a'));
    expect(first.configDir.normalize('NFC')).toBe(first.configDir);

    // Byte-stability: repeated resolves return the SAME frozen object and
    // identical string references (the keychain hash is over raw bytes).
    const second = registry.resolve('MAX_A');
    expect(second).toBe(first);
    expect(second.configDir).toBe(first.configDir);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('NFC-normalizes override paths too', () => {
    const home = scratch();
    const nfdPath = '/synthetic/e\u0301tude/max-a'; // decomposed e + COMBINING ACUTE
    writeFileSync(join(home, 'profiles.json'), JSON.stringify({ MAX_A: { configDir: nfdPath } }));
    const registry = createProfileRegistry({ aibenderHome: home });
    expect(registry.resolve('MAX_A').configDir).toBe(nfdPath.normalize('NFC'));
  });

  it('ignores $-prefixed comment keys in manifests and overrides', () => {
    const manifest = parseProfilesManifest(
      JSON.stringify({ accounts: { $comment: 'ignored', MAX_A: { dirName: 'max-a' } } }),
    );
    expect(manifest.accounts['MAX_A']?.dirName).toBe('max-a');

    const home = scratch();
    writeFileSync(join(home, 'profiles.json'), JSON.stringify({ $where: 'ignored' }));
    const registry = createProfileRegistry({ aibenderHome: home });
    expect(registry.resolve('MAX_A').configDir).toBe(join(home, 'accounts', 'max-a'));
  });

  it('a missing manifestPath file falls back to built-in conventions', () => {
    const registry = createProfileRegistry({
      aibenderHome: '/synthetic/home',
      manifestPath: '/synthetic/does-not-exist/accounts.json',
    });
    expect(registry.resolve('MAX_A').configDir).toBe('/synthetic/home/accounts/max-a');
  });
});

// ---------------------------------------------------------------------------
// ICR-0013: the OPEN Claude-account form (MAX_C/MAX_D via the registry)
// ---------------------------------------------------------------------------

describe('profile registry — open account form (ICR-0013)', () => {
  function accountRegistryWith(labels: readonly { stem: string; label: string }[], home: string) {
    const dir = scratch();
    for (const { stem, label } of labels) {
      const conv = `$AIBENDER_HOME/accounts/${stem}`;
      writeFileSync(
        join(dir, `${stem}.profile.json`),
        JSON.stringify({
          $comment: 'synthesized fixture — placeholder label only [X2]',
          schemaVersion: 1,
          label,
          kind: label === 'ENT' ? 'enterprise' : 'max',
          pathConvention: conv,
          env: { CLAUDE_CONFIG_DIR: conv, CLAUDE_SECURESTORAGE_CONFIG_DIR: conv },
        }),
      );
    }
    return createAccountRegistry({ profilesDir: dir, aibenderHome: home });
  }

  it('isClaudeProfileLabel keys off the FORM, not the seed set (MAX_C/MAX_D pass, AWS_DEV/junk fail)', () => {
    expect(isClaudeProfileLabel('MAX_C')).toBe(true);
    expect(isClaudeProfileLabel('MAX_D')).toBe(true);
    expect(isClaudeProfileLabel('MAX_Z')).toBe(true);
    expect(isClaudeProfileLabel('ENT')).toBe(true);
    expect(isClaudeProfileLabel('AWS_DEV')).toBe(false);
    expect(isClaudeProfileLabel('LOCAL')).toBe(false);
    expect(isClaudeProfileLabel('MAX_AB')).toBe(false);
    expect(isClaudeProfileLabel('max_c')).toBe(false);
    expect(isClaudeProfileLabel('HACKER')).toBe(false);
  });

  it('resolves a FOURTH account (MAX_C) when the discovered registry provides it — no code change', () => {
    const home = '/synthetic/home';
    const accountRegistry = accountRegistryWith(
      [
        { stem: 'max-a', label: 'MAX_A' },
        { stem: 'max-b', label: 'MAX_B' },
        { stem: 'ent', label: 'ENT' },
        { stem: 'max-c', label: 'MAX_C' },
      ],
      home,
    );
    const registry = createProfileRegistry({ aibenderHome: home, accountRegistry });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);
    const c = registry.resolve('MAX_C');
    expect(c.configDir).toBe(join(home, 'accounts', 'max-c'));
    expect(c.securestorageDir).toBe(join(home, 'accounts', 'max-c'));
    expect(c.backend).toBe('claude_code');
  });

  it('resolves a FIFTH account (MAX_D) too; the seed three still resolve alongside it', () => {
    const home = '/synthetic/home';
    const accountRegistry = accountRegistryWith(
      [
        { stem: 'max-a', label: 'MAX_A' },
        { stem: 'max-b', label: 'MAX_B' },
        { stem: 'max-c', label: 'MAX_C' },
        { stem: 'max-d', label: 'MAX_D' },
        { stem: 'ent', label: 'ENT' },
      ],
      home,
    );
    const registry = createProfileRegistry({ aibenderHome: home, accountRegistry });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
    expect(registry.resolve('MAX_D').configDir).toBe(join(home, 'accounts', 'max-d'));
    expect(registry.resolve('MAX_A').configDir).toBe(join(home, 'accounts', 'max-a'));
  });

  it('an override alone (no manifest) can introduce a MAX_C profile', () => {
    const home = scratch();
    writeFileSync(
      join(home, 'profiles.json'),
      JSON.stringify({ MAX_C: { configDir: '/synthetic/custom/max-c-store' } }),
    );
    const registry = createProfileRegistry({ aibenderHome: home });
    expect(registry.labels()).toContain('MAX_C');
    expect(registry.resolve('MAX_C').configDir).toBe('/synthetic/custom/max-c-store');
  });

  it('WITHOUT a registry/override/manifest, an unconfigured MAX_C still throws (gate stays real)', () => {
    // The default seed is MAX_A/MAX_B/ENT only — MAX_C is a valid FORM but is
    // NOT configured on this machine, so resolve must refuse it.
    const registry = createProfileRegistry({ aibenderHome: '/synthetic/home' });
    expect(registry.labels()).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    expect(() => registry.resolve('MAX_C')).toThrow(UnknownProfileError);
  });

  it('accountRegistryOptions convenience builds the registry from a profiles dir', () => {
    const home = '/synthetic/home';
    const dir = scratch();
    const conv = '$AIBENDER_HOME/accounts/max-c';
    writeFileSync(
      join(dir, 'max-c.profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        label: 'MAX_C',
        pathConvention: conv,
        env: { CLAUDE_CONFIG_DIR: conv, CLAUDE_SECURESTORAGE_CONFIG_DIR: conv },
      }),
    );
    const registry = createProfileRegistry({
      aibenderHome: home,
      accountRegistryOptions: { profilesDir: dir },
    });
    expect(registry.resolve('MAX_C').configDir).toBe(join(home, 'accounts', 'max-c'));
  });

  it('defaultDirNameFor maps labels to the plan-§2 dir convention', () => {
    expect(defaultDirNameFor('MAX_A')).toBe('max-a');
    expect(defaultDirNameFor('MAX_C')).toBe('max-c');
    expect(defaultDirNameFor('ENT')).toBe('ent');
  });

  it('the fixed backend labels are still refused by resolve (AWS_DEV/LOCAL ride BE-4)', () => {
    const registry = createProfileRegistry({ aibenderHome: '/synthetic/home' });
    expect(() => registry.resolve('AWS_DEV')).toThrow(/BE-4/);
    expect(() => registry.resolve('LOCAL')).toThrow(UnknownProfileError);
  });
});
