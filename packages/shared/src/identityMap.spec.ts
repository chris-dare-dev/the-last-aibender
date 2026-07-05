import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IdentityMapError,
  emptyIdentityMap,
  identityMapPath,
  loadIdentityMap,
  normalizeIdentity,
  parseIdentityMap,
} from './index.js';

// All identities below are SYNTHESIZED fixtures per [X2] — obviously fake,
// placeholder-labeled (sanctioned forms only: *@example.com, AWS_DEV_ACCOUNT_ID),
// never copied from real accounts.
const FIXTURE = JSON.stringify({
  $comment: 'synthesized test fixture',
  MAX_A: ['max-a@example.com', '00000000-0000-4000-8000-00000000000a'],
  MAX_B: ['max-b@example.com'],
  ENT: [],
  AWS_DEV: ['AWS_DEV_ACCOUNT_ID'],
});

let tempDirs: string[] = [];
const makeHome = (contents?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'aibender-idmap-'));
  tempDirs.push(dir);
  if (contents !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity-map.json'), contents, 'utf8');
  }
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('parseIdentityMap', () => {
  // -- positive --------------------------------------------------------------

  it('parses labels, ignores $-prefixed comment keys, maps identities', () => {
    const map = parseIdentityMap(FIXTURE);
    expect(map.loaded).toBe(true);
    expect(map.size).toBe(4);
    expect(map.labelFor('max-a@example.com')).toBe('MAX_A');
    expect(map.labelFor('AWS_DEV_ACCOUNT_ID')).toBe('AWS_DEV');
    expect(map.labelFor('unknown@example.com')).toBeUndefined();
  });

  it('matches case-insensitively, trimmed, NFC-normalized', () => {
    const map = parseIdentityMap(FIXTURE);
    expect(map.labelFor('  MAX-A@example.com ')).toBe('MAX_A');
    expect(map.labelFor('aws_dev_account_id')).toBe('AWS_DEV');
    expect(normalizeIdentity('  Ümlaut@example.com'.normalize('NFD'))).toBe(
      normalizeIdentity('ümlaut@example.com'),
    );
  });

  // -- negative --------------------------------------------------------------

  it('throws on invalid JSON, non-object roots, non-sanctioned label keys', () => {
    expect(() => parseIdentityMap('{nope')).toThrow(IdentityMapError);
    expect(() => parseIdentityMap('[]')).toThrow(IdentityMapError);
    expect(() => parseIdentityMap('"MAX_A"')).toThrow(IdentityMapError);
    // ICR-0013: the FORM is the ceiling, so a NON-sanctioned key still throws —
    // a word ("HACKER"), a two-letter Max suffix ("MAX_AB"), a lowercase form
    // ("max_a"), and an email-shaped key are all rejected.
    expect(() => parseIdentityMap(JSON.stringify({ HACKER: [] }))).toThrow(IdentityMapError);
    expect(() => parseIdentityMap(JSON.stringify({ MAX_AB: [] }))).toThrow(IdentityMapError);
    expect(() => parseIdentityMap(JSON.stringify({ max_a: [] }))).toThrow(IdentityMapError);
    expect(() => parseIdentityMap(JSON.stringify({ 'x@example.com': [] }))).toThrow(IdentityMapError);
  });

  it('accepts a newly provisioned Max account key (MAX_C/MAX_D) by FORM (ICR-0013)', () => {
    const map = parseIdentityMap(
      JSON.stringify({ MAX_C: ['c@example.com'], MAX_D: ['d@example.com'] }),
    );
    expect(map.size).toBe(2);
    expect(map.labelFor('c@example.com')).toBe('MAX_C');
    expect(map.labelFor('d@example.com')).toBe('MAX_D');
  });

  it('throws on non-array values, non-string or blank identities', () => {
    expect(() => parseIdentityMap(JSON.stringify({ MAX_A: 'solo@example.com' }))).toThrow(
      IdentityMapError,
    );
    expect(() => parseIdentityMap(JSON.stringify({ MAX_A: [42] }))).toThrow(IdentityMapError);
    expect(() => parseIdentityMap(JSON.stringify({ MAX_A: ['  '] }))).toThrow(IdentityMapError);
  });

  it('refuses an identity mapped to two labels (ambiguity)', () => {
    const ambiguous = JSON.stringify({
      MAX_A: ['shared@example.com'],
      MAX_B: ['SHARED@example.com'], // same identity after normalization
    });
    expect(() => parseIdentityMap(ambiguous)).toThrow(/two labels/);
  });

  // -- edge ------------------------------------------------------------------

  it('accepts an all-empty map (the shipped .example shape)', () => {
    const map = parseIdentityMap(JSON.stringify({ MAX_A: [], MAX_B: [], ENT: [], AWS_DEV: [] }));
    expect(map.size).toBe(0);
    expect(map.labelFor('anything')).toBeUndefined();
  });
});

describe('loadIdentityMap', () => {
  // -- positive --------------------------------------------------------------

  it('loads from $AIBENDER_HOME/identity-map.json', () => {
    const home = makeHome(FIXTURE);
    const map = loadIdentityMap({ env: { AIBENDER_HOME: home } });
    expect(map.loaded).toBe(true);
    expect(map.source).toBe(join(home, 'identity-map.json'));
    expect(map.labelFor('max-b@example.com')).toBe('MAX_B');
  });

  it('explicit aibenderHome option wins over env', () => {
    const home = makeHome(FIXTURE);
    const map = loadIdentityMap({ aibenderHome: home, env: { AIBENDER_HOME: '/nonexistent' } });
    expect(map.loaded).toBe(true);
  });

  // -- negative --------------------------------------------------------------

  it('missing file → empty map with loaded:false (never a throw)', () => {
    const home = makeHome(); // no file written
    const map = loadIdentityMap({ aibenderHome: home });
    expect(map.loaded).toBe(false);
    expect(map.size).toBe(0);
    expect(map.labelFor('max-a@example.com')).toBeUndefined();
  });

  it('malformed file → loud IdentityMapError, never a silent partial map', () => {
    const home = makeHome('{"MAX_A": [1]}');
    expect(() => loadIdentityMap({ aibenderHome: home })).toThrow(IdentityMapError);
  });

  // -- edge ------------------------------------------------------------------

  it('defaults the path to ~/.aibender when no env/override is present', () => {
    expect(identityMapPath({ env: {} })).toMatch(/\.aibender\/identity-map\.json$/);
  });

  it('emptyIdentityMap has no entries and never matches', () => {
    const map = emptyIdentityMap();
    expect(map.entries()).toEqual([]);
    expect(map.labelFor('')).toBeUndefined();
  });

  it('the committed pointer example (infra/profiles) parses and is empty [X2]', () => {
    // Drift guard: the .example the repo ships must always satisfy the loader.
    const examplePath = new URL(
      '../../../infra/profiles/identity-map.example.json',
      import.meta.url,
    );
    const map = parseIdentityMap(readFileSync(examplePath, 'utf8'), examplePath.pathname);
    expect(map.size).toBe(0); // committed values must be EMPTY — placeholders only
  });
});
