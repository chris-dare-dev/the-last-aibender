/**
 * FE-6 catalog palette assembly — the builder's capability palette over the
 * FROZEN `catalog-snapshot` payload (ws-protocol.md §18.1; findings §R1: one
 * scanner, three consumers). The palette is kind-GROUPED (skill / command /
 * agent / workflow / oc-agent / oc-command / plugin) in a fixed order so the
 * builder learns *where to glance* (the flight-deck principle, DESIGN.md §2.5
 * applied to the palette), and DEGRADED / MALFORMED entries render as
 * instrument states — never hidden (plan §5/FE-6: "degraded/malformed rows
 * rendered as instrument states, never hidden"; the NO SIGNAL doctrine
 * §2.4 — an absent/degraded source is a reading, not an error toast).
 *
 * The wire `CatalogEntry` is the scanner's NORMALIZED record (the frontmatter
 * is deliberately off-wire, §18.1). "Degraded" is therefore what the FE can
 * detect from the normalized shape without the frontmatter:
 *   - `relative-source`   sourcePath is not absolute (scanner drift / a
 *                         non-canonical resolution — the golden
 *                         `pipelines-catalog-relative-sourcepath` fixture);
 *   - `unhashed`          contentHash is not `sha256:…` shaped (no
 *                         reproducibility pin — a rerun cannot detect drift);
 *   - `model-invocation-disabled`  the capability is user-only
 *                         (`disable-model-invocation`) — legal, but NOT usable
 *                         as a pipeline step (an instrument state, dimmed,
 *                         non-selectable, never removed from the palette).
 * `ok` entries are selectable as builder steps. Multiple flags can apply; the
 * most severe (blocks selection) wins for the row's readout.
 *
 * [X2]: entries carry paths + names + placeholder labels only. Display fields
 * are shape-masked at render; accounts render only as the frozen labels.
 */

import type { AccountLabel, CapabilityKind, CatalogEntry } from '@aibender/protocol';
import { CAPABILITY_KINDS } from '@aibender/protocol';

/** Fixed palette group order (findings §R1 precedence flavor, glanceable). */
export const PALETTE_KIND_ORDER: readonly CapabilityKind[] = CAPABILITY_KINDS;

/** A degradation signal detectable from the normalized wire record. */
export type CatalogHealthFlag = 'relative-source' | 'unhashed' | 'model-invocation-disabled';

/** Overall selectability register for a palette row (never color-only). */
export type CatalogRowStatus = 'ok' | 'degraded' | 'unusable';

/** `sha256:` + at least one hex char (the reproducibility-pin shape). */
const CONTENT_HASH_RE = /^sha256:[0-9a-fA-F]+$/;

/** One palette row — the entry plus its FE-detectable instrument state. */
export interface CatalogRow {
  readonly entry: CatalogEntry;
  readonly flags: readonly CatalogHealthFlag[];
  readonly status: CatalogRowStatus;
  /** True when the entry may be dropped onto the canvas as a step. */
  readonly selectable: boolean;
}

/** One kind group in fixed palette order (empty groups still render a header). */
export interface CatalogGroup {
  readonly kind: CapabilityKind;
  readonly rows: readonly CatalogRow[];
}

/** Classify one normalized catalog entry into its instrument state. */
export function classifyCatalogEntry(entry: CatalogEntry): CatalogRow {
  const flags: CatalogHealthFlag[] = [];
  if (!entry.sourcePath.startsWith('/')) flags.push('relative-source');
  if (!CONTENT_HASH_RE.test(entry.contentHash)) flags.push('unhashed');
  if (entry.disableModelInvocation === true) flags.push('model-invocation-disabled');

  // model-invocation-disabled makes an entry UNUSABLE as a step (it renders,
  // dimmed + labeled, but cannot be dropped). Other flags degrade but do not
  // block selection (a relative path still resolves; an unhashed entry still
  // runs — drift detection is just weaker).
  const unusable = flags.includes('model-invocation-disabled');
  const status: CatalogRowStatus = unusable
    ? 'unusable'
    : flags.length > 0
      ? 'degraded'
      : 'ok';
  return { entry, flags, status, selectable: !unusable };
}

/**
 * Group + sort the palette for render: kind groups in {@link PALETTE_KIND_ORDER},
 * rows within a group sorted by name (stable, deterministic render). Degraded
 * and unusable rows are RETAINED in their group (never filtered) — visibility
 * of a degraded capability is the whole point (a builder must see that a skill
 * exists but is unhashed, not silently lose it).
 */
export function buildPalette(entries: readonly CatalogEntry[]): readonly CatalogGroup[] {
  const byKind = new Map<CapabilityKind, CatalogRow[]>();
  for (const kind of PALETTE_KIND_ORDER) byKind.set(kind, []);
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind);
    // Unknown kinds cannot occur (the frozen validator refuses them upstream);
    // defensively skip rather than throw if one ever slipped the wire.
    if (bucket === undefined) continue;
    bucket.push(classifyCatalogEntry(entry));
  }
  const groups: CatalogGroup[] = [];
  for (const kind of PALETTE_KIND_ORDER) {
    const rows = (byKind.get(kind) ?? []).slice();
    rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    groups.push({ kind, rows });
  }
  return groups;
}

/** Palette health rollup for the panel readout (glanceable degradation count). */
export interface PaletteHealth {
  readonly total: number;
  readonly degraded: number;
  readonly unusable: number;
}

export function paletteHealth(groups: readonly CatalogGroup[]): PaletteHealth {
  let total = 0;
  let degraded = 0;
  let unusable = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      total += 1;
      if (row.status === 'degraded') degraded += 1;
      else if (row.status === 'unusable') unusable += 1;
    }
  }
  return { total, degraded, unusable };
}

/**
 * The single account label an entry resolves for, when the scanner recorded
 * exactly one (user/plugin scope). Multiple/absent → undefined (the builder
 * applies the step/defaults routing instead). Placeholder labels only [X2].
 */
export function soleAccountOf(entry: CatalogEntry): AccountLabel | undefined {
  return entry.accounts !== undefined && entry.accounts.length === 1
    ? entry.accounts[0]
    : undefined;
}
