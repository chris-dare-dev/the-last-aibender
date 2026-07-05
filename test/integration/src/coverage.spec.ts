/**
 * INTEG coverage-completeness guard: the §9.3 matrix rows this suite is
 * responsible for each have a live spec file. If a seam file is deleted or
 * renamed without updating this list, THIS test fails — the same "not silently
 * dropped" discipline the live-check meta-test applies to the T3 half, applied
 * to the synthetic-green half.
 *
 * This is a cheap structural backstop, not a substitute for the seam tests
 * themselves; it guards against the matrix quietly shrinking.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

/** §9.3 row → the spec file that assembles it (synthetic-green subset). */
const SEAM_FILES: ReadonlyArray<{ seam: string; file: string }> = [
  { seam: 'BE↔FE #1 golden both-sides', file: 'be-fe/golden-both-sides.spec.ts' },
  { seam: 'BE↔FE #2 PTY flow-control soak', file: 'be-fe/pty-flow-control.spec.ts' },
  { seam: 'BE↔FE #3 dashboard truth', file: 'be-fe/dashboard-truth.spec.ts' },
  { seam: 'BE↔FE #4 approval round-trip (M2+M5)', file: 'be-fe/approval-round-trip.spec.ts' },
  { seam: 'BE↔FE #5 reconnect + graph converge', file: 'be-fe/reconnect.spec.ts' },
  { seam: 'BE↔SI #2 keychain service names', file: 'be-si/keychain-service-names.spec.ts' },
  { seam: 'BE↔SI #3/#4 hooks + OTel ingest', file: 'be-si/hooks-otel-ingest.spec.ts' },
  { seam: 'BE↔SI #5 [X3] non-dependency', file: 'be-si/x3-non-dependency.spec.ts' },
  { seam: 'SI↔FE #3 DESIGN token propagation', file: 'si-fe/design-token-propagation.spec.ts' },
  { seam: 'SI↔FE #4 freshness NO SIGNAL', file: 'si-fe/freshness-no-signal.spec.tsx' },
  { seam: '§9.4 T3 enumeration meta-test', file: 't3/live-check-enumeration.spec.ts' },
];

describe('INTEG §9.3 matrix coverage is complete', () => {
  it.each(SEAM_FILES.map((s) => [s.seam, s.file] as const))(
    '%s → %s exists',
    (_seam, file) => {
      expect(existsSync(join(SRC, file)), `missing seam spec: ${file}`).toBe(true);
    },
  );

  it('covers all three department pairs', () => {
    const pairs = new Set(SEAM_FILES.map((s) => s.file.split('/')[0]));
    expect(pairs.has('be-fe')).toBe(true);
    expect(pairs.has('be-si')).toBe(true);
    expect(pairs.has('si-fe')).toBe(true);
    expect(pairs.has('t3')).toBe(true);
  });
});
