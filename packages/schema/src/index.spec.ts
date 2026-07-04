import { describe, expect, it } from 'vitest';

import { assertMigrationOrder, type Migration, type MigrationRunner } from './index.js';

const m = (id: number, name = `step-${id}`): Migration => ({ id, name, up: '-- ddl' });

describe('@aibender/schema (migration-runner stub)', () => {
  it('imports and the MigrationRunner interface is implementable by a fake', async () => {
    const fake: MigrationRunner = {
      applied: async () => [],
      apply: async (pending) => pending.map((p) => ({ id: p.id, name: p.name, appliedAtIso: '2026-01-01T00:00:00.000Z' })),
    };
    const rows = await fake.apply([m(1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
  });

  // -- positive ------------------------------------------------------------

  it('accepts a strictly-increasing migration list', () => {
    expect(() => assertMigrationOrder([m(1), m(2), m(10)])).not.toThrow();
  });

  // -- negative ------------------------------------------------------------

  it('rejects duplicate and decreasing ids', () => {
    expect(() => assertMigrationOrder([m(1), m(1)])).toThrow(RangeError);
    expect(() => assertMigrationOrder([m(2), m(1)])).toThrow(RangeError);
  });

  it('rejects non-positive, non-integer ids and blank names', () => {
    expect(() => assertMigrationOrder([m(0)])).toThrow(RangeError);
    expect(() => assertMigrationOrder([m(-3)])).toThrow(RangeError);
    expect(() => assertMigrationOrder([m(1.5)])).toThrow(RangeError);
    expect(() => assertMigrationOrder([m(1, '   ')])).toThrow(RangeError);
  });

  // -- edge ----------------------------------------------------------------

  it('accepts an empty list (fresh store, nothing to order)', () => {
    expect(() => assertMigrationOrder([])).not.toThrow();
  });

  it('accepts gaps in ids (ids are ordinals, not indexes)', () => {
    expect(() => assertMigrationOrder([m(5), m(500)])).not.toThrow();
  });

  it('rejects ids beyond the safe-integer range', () => {
    expect(() => assertMigrationOrder([m(Number.MAX_SAFE_INTEGER + 2)])).toThrow(RangeError);
  });
});
