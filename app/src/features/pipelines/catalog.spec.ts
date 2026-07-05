/**
 * Catalog palette assembly (plan §9.2 FE-6 + the FE-6 brief's palette
 * degraded-row rendering): entries are kind-GROUPED in the fixed palette
 * order; DEGRADED / UNUSABLE entries are classified as instrument states and
 * RETAINED (never hidden — visibility of a degraded capability is the point);
 * the frozen relative-source fixture is flagged, not dropped.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITY_KINDS } from '@aibender/protocol';
import {
  PALETTE_KIND_ORDER,
  buildPalette,
  classifyCatalogEntry,
  paletteHealth,
  soleAccountOf,
} from './catalog.ts';
import { catalogEntry } from './specHelpers.ts';

describe('catalog entry classification (instrument states, never hidden)', () => {
  it('a well-formed entry classifies ok + selectable', () => {
    const row = classifyCatalogEntry(catalogEntry('cap_ok'));
    expect(row.status).toBe('ok');
    expect(row.selectable).toBe(true);
    expect(row.flags).toEqual([]);
  });

  it('a relative sourcePath is flagged relative-source (the frozen fixture case)', () => {
    // Mirrors the corpus `pipelines-catalog-relative-sourcepath` fixture: the
    // wire tolerates a relative path; the palette surfaces it as a degradation.
    const row = classifyCatalogEntry(catalogEntry('cap_rel', { sourcePath: 'relative/SKILL.md' }));
    expect(row.flags).toContain('relative-source');
    expect(row.status).toBe('degraded');
    expect(row.selectable).toBe(true); // degraded ≠ unusable
  });

  it('a non-sha256 contentHash is flagged unhashed', () => {
    const row = classifyCatalogEntry(catalogEntry('cap_nohash', { contentHash: 'weak' }));
    expect(row.flags).toContain('unhashed');
    expect(row.status).toBe('degraded');
  });

  it('a disable-model-invocation entry is UNUSABLE (renders, not selectable)', () => {
    const row = classifyCatalogEntry(
      catalogEntry('cap_user', { disableModelInvocation: true }),
    );
    expect(row.flags).toContain('model-invocation-disabled');
    expect(row.status).toBe('unusable');
    expect(row.selectable).toBe(false);
  });

  it('multiple degradations all render; unusable dominates the status', () => {
    const row = classifyCatalogEntry(
      catalogEntry('cap_both', {
        sourcePath: 'rel/x.md',
        contentHash: 'nope',
        disableModelInvocation: true,
      }),
    );
    expect(row.flags).toEqual(['relative-source', 'unhashed', 'model-invocation-disabled']);
    expect(row.status).toBe('unusable');
    expect(row.selectable).toBe(false);
  });
});

describe('palette grouping (fixed kind order, degraded rows retained)', () => {
  it('groups every capability kind in the frozen palette order', () => {
    const groups = buildPalette([]);
    expect(groups.map((g) => g.kind)).toEqual([...CAPABILITY_KINDS]);
    expect(PALETTE_KIND_ORDER).toEqual(CAPABILITY_KINDS);
  });

  it('sorts rows by name within a group and retains degraded rows', () => {
    const groups = buildPalette([
      catalogEntry('cap_z', { kind: 'skill', name: 'zeta' }),
      catalogEntry('cap_a', { kind: 'skill', name: 'alpha', sourcePath: 'rel/a.md' }),
      catalogEntry('cap_agent', { kind: 'agent', name: 'reviewer' }),
    ]);
    const skills = groups.find((g) => g.kind === 'skill');
    expect(skills?.rows.map((r) => r.entry.name)).toEqual(['alpha', 'zeta']);
    // The degraded 'alpha' is RETAINED, not filtered.
    expect(skills?.rows[0]?.status).toBe('degraded');
    const agents = groups.find((g) => g.kind === 'agent');
    expect(agents?.rows).toHaveLength(1);
  });

  it('paletteHealth rolls up total / degraded / unusable', () => {
    const groups = buildPalette([
      catalogEntry('cap_ok'),
      catalogEntry('cap_deg', { sourcePath: 'rel/x.md' }),
      catalogEntry('cap_un', { disableModelInvocation: true }),
    ]);
    expect(paletteHealth(groups)).toEqual({ total: 3, degraded: 1, unusable: 1 });
  });
});

describe('sole account resolution (placeholder labels only [X2])', () => {
  it('returns the single account when the scanner recorded exactly one', () => {
    expect(soleAccountOf(catalogEntry('c', { accounts: ['ENT'] }))).toBe('ENT');
  });
  it('returns undefined for multiple / absent accounts', () => {
    expect(soleAccountOf(catalogEntry('c', { accounts: ['ENT', 'MAX_A'] }))).toBeUndefined();
    expect(soleAccountOf(catalogEntry('c'))).toBeUndefined();
  });
});
