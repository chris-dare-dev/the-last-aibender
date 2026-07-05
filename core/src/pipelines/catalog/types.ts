/**
 * The normalized capability-catalog record (BE-8; findings
 * pipeline-workflow-builder §R1 "One catalog service, three consumers,
 * producing normalized records"). ONE scanner produces these; THREE consumers
 * read them — the pipeline builder palette (the frozen wire `CatalogEntry`,
 * pipelines.ts §18.1), the one-off launcher (feature 2/3 pickers), and the
 * context graph (skills/agents as artifact nodes).
 *
 * This is the SUPERSET the scanner holds in memory. The wire `CatalogEntry`
 * (paths + names + labels only [X2]) is a PROJECTION of it — the raw parsed
 * frontmatter (which can carry arbitrary user keys) stays scanner-side and is
 * deliberately NOT put on the wire (findings §R1). A DEGRADED entry (malformed
 * frontmatter) is a first-class row, never a dropped scan or a crash.
 */

import type { AccountLabel } from '@aibender/protocol';
import type {
  CapabilityBackendFamily,
  CapabilityKind,
  CatalogScope,
} from '@aibender/protocol';

import type { Frontmatter } from './frontmatter.js';

/**
 * One scanned capability. `capId` is minted per (sourcePath, name, scope,
 * workspace) so the same file scanned twice yields the SAME id (idempotent
 * re-scan — the FSEvents live-reload rule). `contentHash` pins the source for
 * plan-time drift detection (findings §R2: "the resolved sourcePath +
 * contentHash are pinned into the run record").
 */
export interface CatalogRecord {
  readonly capId: string;
  readonly kind: CapabilityKind;
  /** Invocation name (post-namespacing, e.g. `my-plugin:review`). */
  readonly name: string;
  readonly scope: CatalogScope;
  readonly backendFamily: CapabilityBackendFamily;
  /** Absolute workspace path this entry resolves for; absent = user/global. */
  readonly workspace?: string;
  /** Absolute source path (SKILL.md / agent md / command md / script). */
  readonly sourcePath: string;
  /** `sha256:…` content hash for reproducibility pinning. */
  readonly contentHash: string;
  /** Slash invocation, when one exists (`/argocd-debug`). */
  readonly slash?: string;
  /** Autocomplete hint from `argument-hint` frontmatter (`[issue-number]`). */
  readonly argumentHint?: string;
  /** `disable-model-invocation: true` → user-only invocation. */
  readonly disableModelInvocation?: boolean;
  /** Account config dirs this entry resolves for (user/plugin scope). */
  readonly accounts?: readonly AccountLabel[];
  /**
   * The FULL parsed frontmatter, unknown keys preserved (findings §R1). Held
   * scanner-side only — never projected onto the wire. Present iff the block
   * parsed; a degraded row has none (`degraded` set instead).
   */
  readonly frontmatter?: Frontmatter;
  /**
   * Set when the frontmatter block was malformed (the DoD malformed-YAML
   * survival case): the row still lists (filename-derived name, no
   * description) with an identifier-free diagnostic — never a crash.
   */
  readonly degraded?: { readonly reason: string };
}

/**
 * The scan result for one (workspace, account-config-dir) resolution: the
 * precedence-resolved records plus the raw pre-precedence records (so the UI
 * can show what a higher-scope entry SHADOWS). `capturedAt` epoch ms drives
 * the wire `catalog-snapshot`.
 */
export interface CatalogScanResult {
  readonly capturedAt: number;
  /** Absolute workspace this palette resolves for; absent = user/global only. */
  readonly workspace?: string;
  /**
   * The winners after precedence + walk-up + name-collision resolution — the
   * builder palette (one entry per resolved invocation name).
   */
  readonly entries: readonly CatalogRecord[];
  /**
   * Entries SHADOWED by a higher-precedence entry of the same name (kept so
   * the builder can surface "overridden by enterprise", never silently gone).
   */
  readonly shadowed: readonly CatalogRecord[];
}
