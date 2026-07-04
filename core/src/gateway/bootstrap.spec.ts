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
