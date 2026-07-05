/**
 * FE-4 artifact classifier — pure path/relation → {@link GraphNodeKind}
 * mapping (blueprint §8 node vocabulary: CLAUDE.md / memory / agent
 * artifacts / references, plus sessions).
 *
 * Deterministic and value-free: decisions come from the path SHAPE and the
 * frozen relation vocabulary (ws-protocol.md §12) only. Rules, in order:
 *
 *   1. `CLAUDE.md` / `CLAUDE.local.md` basenames, or the `instructions`
 *      relation → `claude-md` (InstructionsLoaded covers rules files too).
 *   2. `MEMORY.md` basename or a `/memory/` path segment → `memory`.
 *   3. `write` relation → `agent-artifact` (the session produced it).
 *   4. everything else → `reference`.
 *
 * A later `write` touch UPGRADES `reference` → `agent-artifact`;
 * `claude-md`/`memory` never re-classify (instructions identity is
 * stronger than produced-ness).
 */

import type { ContextGraphRelation } from '@aibender/protocol';
import type { GraphNodeKind } from './types.ts';

const CLAUDE_MD_BASENAMES = new Set(['claude.md', 'claude.local.md']);
const MEMORY_BASENAMES = new Set(['memory.md']);

/** Last path segment, lower-cased (paths are POSIX-absolute per contract). */
export function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return (idx === -1 ? path : path.slice(idx + 1)).toLowerCase();
}

/** Classify one artifact touch. Pure; never throws. */
export function classifyArtifact(path: string, relation: ContextGraphRelation): GraphNodeKind {
  const base = basenameOf(path);
  if (CLAUDE_MD_BASENAMES.has(base) || relation === 'instructions') return 'claude-md';
  if (MEMORY_BASENAMES.has(base) || path.toLowerCase().includes('/memory/')) return 'memory';
  if (relation === 'write') return 'agent-artifact';
  return 'reference';
}

/** Re-touch upgrade rule (see module doc). */
export function upgradeKind(current: GraphNodeKind, touched: GraphNodeKind): GraphNodeKind {
  if (current === 'reference' && touched === 'agent-artifact') return 'agent-artifact';
  return current;
}
