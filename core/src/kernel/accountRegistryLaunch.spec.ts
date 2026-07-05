/**
 * accountRegistryLaunch.spec.ts — the [X1] end-to-end proof (ICR-0013).
 *
 * THE WHOLE POINT: a newly provisioned Claude Max account launches through the
 * EXISTING kernel path with ZERO code change — only its `*.profile.json`
 * manifest is added. This test drives the discovered {@link createAccountRegistry}
 * → {@link createProfileRegistry} → {@link createSessionKernel} chain against a
 * FIXTURE profiles dir (rule 3 — never the real ~/.aibender/accounts/*), and
 * asserts the FakeQueryRunner (@aibender/testkit) received the correct
 * per-account spawn env for the 4th account, no special-casing.
 *
 * Fixtures are placeholder labels only [X2].
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { LaunchParams } from '@aibender/protocol';
import { backendForLabel } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { FakeQueryRunner } from '@aibender/testkit';

import { createAccountRegistry } from './accountRegistry.js';
import { KernelError, UnknownProfileError } from './errors.js';
import { createProfileRegistry } from './profiles.js';
import { createSessionKernel } from './sessionKernel.js';

const HOME = '/synthetic/aibender-home';
const CWD = '/synthetic/workspace';

const stores: KernelStore[] = [];
const scratchDirs: string[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function profilesDirWith(labels: readonly { stem: string; label: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibender-launch-registry-'));
  scratchDirs.push(dir);
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
  return dir;
}

/**
 * Build a session kernel over the DISCOVERED registry (no hardcoded label set).
 * The `profilesDir` fixture is the ONLY input that decides which accounts exist.
 */
async function kernelOverRegistry(profilesDir: string) {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const runner = new FakeQueryRunner({});
  const accountRegistry = createAccountRegistry({ profilesDir, aibenderHome: HOME });
  const profiles = createProfileRegistry({ aibenderHome: HOME, accountRegistry });
  const kernel = createSessionKernel({
    ledger: store.resumeLedger,
    profiles,
    runner,
    baseEnv: { PATH: '/usr/bin' },
  });
  return { store, runner, profiles, accountRegistry, kernel };
}

function launchParams(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate: 'sdk',
    cwd: CWD,
    purpose: 'synthesized registry-launch test',
    prompt: 'synthesized prompt',
    ...overrides,
  };
}

const SEED_5 = [
  { stem: 'max-a', label: 'MAX_A' },
  { stem: 'max-b', label: 'MAX_B' },
  { stem: 'max-c', label: 'MAX_C' },
  { stem: 'max-d', label: 'MAX_D' },
  { stem: 'ent', label: 'ENT' },
] as const;

// ---------------------------------------------------------------------------
// THE PROOF — a 4th/5th account launches with no code change
// ---------------------------------------------------------------------------

describe('account registry → kernel launch (the [X1] proof)', () => {
  it('a FOURTH account (MAX_C) launches through the existing kernel path, correct spawn env', async () => {
    // 4-account fixture: A, B, C, ENT. Adding MAX_C is JUST its manifest.
    const dir = profilesDirWith([
      { stem: 'max-a', label: 'MAX_A' },
      { stem: 'max-b', label: 'MAX_B' },
      { stem: 'max-c', label: 'MAX_C' },
      { stem: 'ent', label: 'ENT' },
    ]);
    const { runner, kernel } = await kernelOverRegistry(dir);

    const session = await kernel.launch(launchParams({ accountLabel: 'MAX_C' }));
    await session.waitForExit();

    const spec = runner.starts[0];
    expect(spec).toBeDefined();
    expect(spec?.env['CLAUDE_CONFIG_DIR']).toBe(join(HOME, 'accounts', 'max-c'));
    expect(spec?.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(join(HOME, 'accounts', 'max-c'));
    // OTel resource attr carries the label, per-account isolated.
    expect(spec?.env['OTEL_RESOURCE_ATTRIBUTES']).toBe('account=MAX_C');
  });

  it('a FIFTH account (MAX_D) launches too — each account gets a distinct config dir', async () => {
    const dir = profilesDirWith(SEED_5);
    const { runner, kernel, accountRegistry } = await kernelOverRegistry(dir);
    expect(accountRegistry.labels()).toEqual(['MAX_A', 'MAX_B', 'MAX_C', 'MAX_D', 'ENT']);

    await (await kernel.launch(launchParams({ accountLabel: 'MAX_C' }))).waitForExit();
    await (await kernel.launch(launchParams({ accountLabel: 'MAX_D' }))).waitForExit();

    const dirs = runner.starts.map((s) => s.env['CLAUDE_CONFIG_DIR']);
    expect(dirs).toEqual([join(HOME, 'accounts', 'max-c'), join(HOME, 'accounts', 'max-d')]);
    // No cross-contamination between the two accounts' envs.
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it('three concurrent accounts across the ladder get three non-cross-contaminating envs', async () => {
    const dir = profilesDirWith(SEED_5);
    const { runner, kernel } = await kernelOverRegistry(dir);
    await Promise.all([
      kernel.launch(launchParams({ accountLabel: 'MAX_B' })).then((s) => s.waitForExit()),
      kernel.launch(launchParams({ accountLabel: 'MAX_C' })).then((s) => s.waitForExit()),
      kernel.launch(launchParams({ accountLabel: 'MAX_D' })).then((s) => s.waitForExit()),
    ]);
    const seen = new Set(runner.starts.map((s) => s.env['CLAUDE_CONFIG_DIR']));
    expect(seen).toEqual(
      new Set([
        join(HOME, 'accounts', 'max-b'),
        join(HOME, 'accounts', 'max-c'),
        join(HOME, 'accounts', 'max-d'),
      ]),
    );
  });

  it('backendForLabel is correct for every discovered label (all Claude accounts → claude_code)', async () => {
    const dir = profilesDirWith(SEED_5);
    const { accountRegistry } = await kernelOverRegistry(dir);
    for (const label of accountRegistry.labels()) {
      expect(backendForLabel(label)).toBe('claude_code');
    }
  });
});

// ---------------------------------------------------------------------------
// The gate stays real — an unconfigured or non-sanctioned label is refused
// ---------------------------------------------------------------------------

describe('account registry → kernel launch (the gate stays real)', () => {
  it('an account NOT in the registry is refused at profile resolve (UnknownProfileError)', async () => {
    // Only A/B/ENT provisioned — MAX_C has no manifest, so it must NOT resolve.
    const dir = profilesDirWith([
      { stem: 'max-a', label: 'MAX_A' },
      { stem: 'max-b', label: 'MAX_B' },
      { stem: 'ent', label: 'ENT' },
    ]);
    const { profiles, kernel } = await kernelOverRegistry(dir);
    expect(profiles.labels()).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    // MAX_C is a VALID form but UNconfigured on this machine → refused.
    expect(() => profiles.resolve('MAX_C')).toThrow(UnknownProfileError);
    await expect(kernel.launch(launchParams({ accountLabel: 'MAX_C' }))).rejects.toThrow(
      UnknownProfileError,
    );
  });

  it('a non-sanctioned label is refused (the form is a real gate, not anything-goes)', async () => {
    const dir = profilesDirWith(SEED_5);
    const { kernel } = await kernelOverRegistry(dir);
    await expect(
      kernel.launch(launchParams({ accountLabel: 'HACKER' as never })),
    ).rejects.toThrow(UnknownProfileError);
  });

  it('a fixed backend label (AWS_DEV/LOCAL) is refused at the kernel (rides BE-4 adapters)', async () => {
    const dir = profilesDirWith(SEED_5);
    const { kernel } = await kernelOverRegistry(dir);
    await expect(
      kernel.launch(launchParams({ accountLabel: 'AWS_DEV', backend: 'opencode' })),
    ).rejects.toThrow(UnknownProfileError);
  });

  it('the label/backend pairing is still enforced (MAX_C with a wrong backend is rejected)', async () => {
    const dir = profilesDirWith(SEED_5);
    const { kernel } = await kernelOverRegistry(dir);
    await expect(
      // MAX_C is configured, but claims the wrong backend.
      kernel.launch(launchParams({ accountLabel: 'MAX_C', backend: 'opencode' })),
    ).rejects.toThrow(KernelError);
  });
});
