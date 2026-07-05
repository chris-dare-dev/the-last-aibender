import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_DIR_MODE,
  BOOTSTRAP_FILE_MODE,
  bootstrapDir,
  bootstrapPath,
  isGatewayBootstrap,
  readBootstrapFile,
  removeBootstrapFile,
  resolveAibenderHome,
  sanitizeClaudeAccountsForBootstrap,
  writeBootstrapFile,
  type GatewayBootstrap,
} from './bootstrap.js';

let home: string;

const sample = (over: Partial<GatewayBootstrap> = {}): GatewayBootstrap => ({
  port: 49152,
  token: 'synthesized-fixture-token-not-real', // [X2] obviously fake
  pid: 4242,
  startedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-boot-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('bootstrap path resolution', () => {
  it('honors an explicit aibenderHome override', () => {
    expect(bootstrapPath({ aibenderHome: '/x/y' })).toBe('/x/y/bootstrap/gateway.json');
  });

  it('falls back to $AIBENDER_HOME from the provided env', () => {
    expect(resolveAibenderHome({ env: { AIBENDER_HOME: '/from-env' } })).toBe('/from-env');
    expect(bootstrapDir({ env: { AIBENDER_HOME: '/from-env' } })).toBe('/from-env/bootstrap');
  });

  it('defaults to ~/.aibender when neither override nor env is present', () => {
    expect(resolveAibenderHome({ env: {} }).endsWith('/.aibender')).toBe(true);
  });
});

describe('writeBootstrapFile', () => {
  // -- positive ---------------------------------------------------------------

  it('writes the {port, token, pid, startedAt} body and reads it back', async () => {
    const body = sample();
    const path = await writeBootstrapFile(body, { aibenderHome: home });
    expect(path).toBe(bootstrapPath({ aibenderHome: home }));
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    expect(raw).toEqual(body);
    expect(await readBootstrapFile({ aibenderHome: home })).toEqual(body);
  });

  it('enforces 0600 on the file and 0700 on the directory', async () => {
    const path = await writeBootstrapFile(sample(), { aibenderHome: home });
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(bootstrapDir({ aibenderHome: home }))).mode & 0o777;
    expect(fileMode).toBe(BOOTSTRAP_FILE_MODE);
    expect(dirMode).toBe(BOOTSTRAP_DIR_MODE);
  });

  it('atomically replaces a previous boot file (no temp residue)', async () => {
    await writeBootstrapFile(sample({ port: 1111 }), { aibenderHome: home });
    await writeBootstrapFile(sample({ port: 2222 }), { aibenderHome: home });
    const read = await readBootstrapFile({ aibenderHome: home });
    expect(read?.port).toBe(2222);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(bootstrapDir({ aibenderHome: home }));
    expect(entries).toEqual(['gateway.json']);
  });

  // -- negative ---------------------------------------------------------------

  it('refuses a malformed body', async () => {
    await expect(
      writeBootstrapFile(sample({ port: 0 }), { aibenderHome: home }),
    ).rejects.toThrow(/malformed/);
    await expect(
      writeBootstrapFile(sample({ token: '' }), { aibenderHome: home }),
    ).rejects.toThrow(/malformed/);
  });

  it('isGatewayBootstrap rejects every field-level corruption', () => {
    expect(isGatewayBootstrap(sample())).toBe(true);
    expect(isGatewayBootstrap(null)).toBe(false);
    expect(isGatewayBootstrap([])).toBe(false);
    expect(isGatewayBootstrap(sample({ port: 65536 }))).toBe(false);
    expect(isGatewayBootstrap(sample({ port: 1.5 }))).toBe(false);
    expect(isGatewayBootstrap(sample({ pid: 0 }))).toBe(false);
    expect(isGatewayBootstrap(sample({ startedAt: 'not-a-date' }))).toBe(false);
    expect(isGatewayBootstrap({ ...sample(), token: 7 })).toBe(false);
  });
});

describe('readBootstrapFile', () => {
  // -- negative ---------------------------------------------------------------

  it('returns undefined for absent, torn, and foreign-shaped files', async () => {
    expect(await readBootstrapFile({ aibenderHome: home })).toBeUndefined();

    const path = bootstrapPath({ aibenderHome: home });
    await writeBootstrapFile(sample(), { aibenderHome: home });
    await writeFile(path, '{"port": 4915', 'utf8'); // torn write simulation
    expect(await readBootstrapFile({ aibenderHome: home })).toBeUndefined();

    await writeFile(path, JSON.stringify({ hello: 'world' }), 'utf8');
    expect(await readBootstrapFile({ aibenderHome: home })).toBeUndefined();
  });
});

describe('removeBootstrapFile (ownership-checked)', () => {
  // -- positive ---------------------------------------------------------------

  it('removes the file when the token matches', async () => {
    const body = sample();
    await writeBootstrapFile(body, { aibenderHome: home });
    expect(await removeBootstrapFile(body.token, { aibenderHome: home })).toBe(true);
    expect(await readBootstrapFile({ aibenderHome: home })).toBeUndefined();
  });

  // -- negative ---------------------------------------------------------------

  it('leaves a newer boot file in place (token mismatch) and reports false', async () => {
    const newer = sample({ token: 'a-newer-boots-synthesized-token' });
    await writeBootstrapFile(newer, { aibenderHome: home });
    expect(await removeBootstrapFile('the-old-boots-token', { aibenderHome: home })).toBe(false);
    expect((await readBootstrapFile({ aibenderHome: home }))?.token).toBe(newer.token);
  });

  // -- edge ---------------------------------------------------------------------

  it('is a no-op on an absent file', async () => {
    expect(await removeBootstrapFile('anything', { aibenderHome: home })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ICR-0014 — the optional `claudeAccounts` carrier ([X1] account registry)
// ---------------------------------------------------------------------------

describe('ICR-0014 claudeAccounts carrier', () => {
  // -- back-compat: the field is OPTIONAL, an M1–M6 file is unchanged ----------

  it('a body WITHOUT claudeAccounts is still valid and writes an M1–M6-shaped file', async () => {
    const body = sample();
    expect(isGatewayBootstrap(body)).toBe(true);
    const path = await writeBootstrapFile(body, { aibenderHome: home });
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    // No `claudeAccounts` key at all — byte-identical to a pre-ICR file shape.
    expect(Object.keys(raw).sort()).toEqual(['pid', 'port', 'startedAt', 'token']);
    expect(await readBootstrapFile({ aibenderHome: home })).toEqual(body);
  });

  it('an empty claudeAccounts list OMITS the field entirely (no-accounts broker)', async () => {
    const path = await writeBootstrapFile(sample({ claudeAccounts: [] }), { aibenderHome: home });
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect('claudeAccounts' in raw).toBe(false);
    // Read-back matches the plain 4-field body (field dropped, not empty array).
    expect(await readBootstrapFile({ aibenderHome: home })).toEqual(sample());
  });

  // -- positive round-trip -----------------------------------------------------

  it('writes and reads back the sanctioned label list in order', async () => {
    const body = sample({ claudeAccounts: ['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D'] });
    await writeBootstrapFile(body, { aibenderHome: home });
    const read = await readBootstrapFile({ aibenderHome: home });
    expect(read?.claudeAccounts).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
  });

  it('the field is NOT part of the boot identity (token/pid/startedAt unchanged)', async () => {
    // Two bodies that differ ONLY in claudeAccounts share the same boot identity.
    const a = sample({ claudeAccounts: ['MAX_A'] });
    const b = sample({ claudeAccounts: ['MAX_A', 'MAX_B', 'MAX_C'] });
    expect(a.token).toBe(b.token);
    expect(a.pid).toBe(b.pid);
    expect(a.startedAt).toBe(b.startedAt);
  });

  // -- [X2] fail-closed sanitization on WRITE ----------------------------------

  it('drops non-sanctioned entries on write (fail-closed [X2]) and dedupes, order-stable', async () => {
    await writeBootstrapFile(
      sample({
        claudeAccounts: [
          'MAX_A', // kept
          'someone@example.com', // real-identity-shaped → dropped
          'MAX_AB', // two letters → dropped (not the FORM)
          'max_c', // lowercase → dropped
          'AWS_DEV', // fixed BACKEND label, not a Claude account → dropped
          'LOCAL', // fixed BACKEND label → dropped
          'ENT', // kept
          'MAX_A', // duplicate → dropped
          'HACKER', // arbitrary → dropped
          'MAX_C', // kept
        ] as readonly string[],
      }),
      { aibenderHome: home },
    );
    const read = await readBootstrapFile({ aibenderHome: home });
    expect(read?.claudeAccounts).toEqual(['MAX_A', 'ENT', 'MAX_C']);
  });

  it('a list of ONLY non-sanctioned entries omits the field (writes a plain body)', async () => {
    const path = await writeBootstrapFile(
      sample({ claudeAccounts: ['AWS_DEV', 'LOCAL', 'evil@example.com'] as readonly string[] }),
      { aibenderHome: home },
    );
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect('claudeAccounts' in raw).toBe(false);
  });

  // -- structural validation ---------------------------------------------------

  it('isGatewayBootstrap accepts an absent field and an array-of-strings', () => {
    expect(isGatewayBootstrap(sample())).toBe(true);
    expect(isGatewayBootstrap(sample({ claudeAccounts: [] }))).toBe(true);
    expect(isGatewayBootstrap(sample({ claudeAccounts: ['MAX_A', 'ENT'] }))).toBe(true);
    // The structural validator does NOT gate the FORM (that is the writer's/
    // FE reader's job) — a non-form string is still structurally an array of
    // strings, so the body validates; the FORM filter runs on write + read.
    expect(isGatewayBootstrap(sample({ claudeAccounts: ['not-a-label'] }))).toBe(true);
  });

  it('isGatewayBootstrap rejects a non-array or a non-string element', () => {
    expect(isGatewayBootstrap({ ...sample(), claudeAccounts: 'MAX_A' })).toBe(false);
    expect(isGatewayBootstrap({ ...sample(), claudeAccounts: {} })).toBe(false);
    expect(isGatewayBootstrap({ ...sample(), claudeAccounts: ['MAX_A', 7] })).toBe(false);
    expect(isGatewayBootstrap({ ...sample(), claudeAccounts: [null] })).toBe(false);
    // A torn/foreign claudeAccounts makes the WHOLE file "no broker advertised".
    expect(isGatewayBootstrap({ ...sample(), claudeAccounts: [{ label: 'MAX_A' }] })).toBe(false);
  });

  // -- read-side re-sanitization (defence in depth) ----------------------------

  it('readBootstrapFile re-sanitizes a hand-tampered file that slipped a bad label', async () => {
    // A file where someone hand-edited a non-form label in AFTER the broker
    // wrote it. The whole array is strings, so isGatewayBootstrap passes; the
    // read-side sanitizer still drops the bad entry (never renders identity).
    const path = bootstrapPath({ aibenderHome: home });
    await writeBootstrapFile(sample(), { aibenderHome: home });
    await writeFile(
      path,
      JSON.stringify({ ...sample(), claudeAccounts: ['MAX_A', 'leaked@example.com', 'MAX_B'] }),
      'utf8',
    );
    const read = await readBootstrapFile({ aibenderHome: home });
    expect(read?.claudeAccounts).toEqual(['MAX_A', 'MAX_B']);
  });

  // -- the exported sanitizer directly -----------------------------------------

  it('sanitizeClaudeAccountsForBootstrap is total and fail-closed', () => {
    expect(sanitizeClaudeAccountsForBootstrap(undefined)).toBeUndefined();
    expect(sanitizeClaudeAccountsForBootstrap([])).toBeUndefined();
    expect(sanitizeClaudeAccountsForBootstrap(['AWS_DEV', 'LOCAL'])).toBeUndefined();
    expect(sanitizeClaudeAccountsForBootstrap([1, null, {}, 'MAX_A'])).toEqual(['MAX_A']);
    expect(sanitizeClaudeAccountsForBootstrap(['MAX_Z', 'ENT', 'MAX_Z'])).toEqual(['MAX_Z', 'ENT']);
  });
});
