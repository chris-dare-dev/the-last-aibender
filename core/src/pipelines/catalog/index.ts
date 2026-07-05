/**
 * core/src/pipelines/catalog — THE ONE capability-catalog scanner (BE-8;
 * findings pipeline-workflow-builder §R1, plan §4/BE-8). One scanner, three
 * consumers (the builder palette, the launcher pickers, the context graph).
 *
 *   frontmatter.ts  the ONE merged parser (unknown-key preservation +
 *                   malformed-YAML survival — two of the four DoD cases)
 *   workflowMeta.ts STATIC meta parse for saved workflow scripts (NEVER
 *                   executed — arch-tested)
 *   fs.ts           the read-only fs port (fixture tree in tests; node:fs at
 *                   runtime — the real account dirs are never touched in tests)
 *   scanner.ts      the walk: skills/commands/agents/workflows/plugins +
 *                   OpenCode (API-first, file fallback), precedence + walk-up
 *                   (the other two DoD cases)
 *   wire.ts         CatalogRecord → frozen `CatalogEntry` projection [X2]
 */

export {
  parseFrontmatter,
  readBoolean,
  readString,
  readStringList,
  type Frontmatter,
  type FrontmatterParseResult,
  type FrontmatterValue,
} from './frontmatter.js';
export { parseWorkflowMeta, type WorkflowMetaResult } from './workflowMeta.js';
export {
  createMemoryCatalogFs,
  createNodeCatalogFs,
  type CatalogDirent,
  type CatalogFixtureTree,
  type CatalogFs,
  type NodeCatalogFsDeps,
} from './fs.js';
export { catalogIdOf, contentHashOf } from './hash.js';
export {
  scanCatalog,
  type AccountConfigDir,
  type OpencodeCapability,
  type OpencodeCatalogSource,
  type ScanCatalogOptions,
} from './scanner.js';
export { recordToCatalogEntry, scanResultToSnapshot } from './wire.js';
export type { CatalogRecord, CatalogScanResult } from './types.js';
