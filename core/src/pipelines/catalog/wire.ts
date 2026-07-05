/**
 * CatalogRecord → frozen wire `CatalogEntry` projection (BE-8; ws-protocol.md
 * §18.1). [X2] BY CONSTRUCTION: the parsed `frontmatter` (arbitrary user keys)
 * and the `degraded` diagnostic are DELIBERATELY NOT projected — the palette
 * needs only the invocation surface (paths + names + labels + hashes). This is
 * the same discipline as the workstream `nodeToWire` (native ids never leave
 * the store).
 */

import type { CatalogEntry, CatalogSnapshot } from '@aibender/protocol';

import type { CatalogRecord, CatalogScanResult } from './types.js';

/** Project one scanner record onto the frozen wire entry. */
export function recordToCatalogEntry(record: CatalogRecord): CatalogEntry {
  return {
    capId: record.capId,
    kind: record.kind,
    name: record.name,
    scope: record.scope,
    backendFamily: record.backendFamily,
    ...(record.workspace !== undefined ? { workspace: record.workspace } : {}),
    sourcePath: record.sourcePath,
    contentHash: record.contentHash,
    ...(record.slash !== undefined ? { slash: record.slash } : {}),
    ...(record.argumentHint !== undefined ? { argumentHint: record.argumentHint } : {}),
    ...(record.disableModelInvocation !== undefined
      ? { disableModelInvocation: record.disableModelInvocation }
      : {}),
    ...(record.accounts !== undefined ? { accounts: record.accounts } : {}),
  };
}

/** Project a full scan result onto the frozen `catalog-snapshot` payload. */
export function scanResultToSnapshot(result: CatalogScanResult): CatalogSnapshot {
  return {
    kind: 'catalog-snapshot',
    capturedAt: result.capturedAt,
    ...(result.workspace !== undefined ? { workspace: result.workspace } : {}),
    entries: result.entries.map(recordToCatalogEntry),
  };
}
