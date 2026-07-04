/**
 * Hook-vocabulary → context-graph relation mapping (BE-6; ws-protocol.md §12,
 * hooks-contract.md §3). The frozen relation table:
 *
 *   read          PostToolUse on read-shaped tools (Read/Glob/Grep/…)
 *   write         PostToolUse on write-shaped tools (Write/Edit/…)
 *   instructions  InstructionsLoaded (CLAUDE.md / rules)
 *   watched       FileChanged (watched artifacts)
 *
 * [X2]: everything in this module handles file paths and tool names only —
 * no account labels, no identity attributes. Paths must be ABSOLUTE
 * (validateContextGraphTouch rejects anything else); relative or non-string
 * path candidates are dropped here, never "fixed up".
 */

import type { ContextGraphRelation } from '@aibender/protocol';

/**
 * Tools whose successful use means the session READ the referenced file(s).
 * Open-ended by design (the CLI adds tools in minor bumps): unknown tools map
 * to NO relation — a graph feed must never guess a touch.
 */
export const READ_SHAPED_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
] as const);

/** Tools whose successful use means the session WROTE the referenced file(s). */
export const WRITE_SHAPED_TOOLS = Object.freeze([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
] as const);

/**
 * Relation for a PostToolUse touch, or undefined when the tool is not
 * file-shaped (Bash, WebFetch, MCP tools, unknown future tools — no touch).
 */
export function relationForTool(toolName: string): Extract<ContextGraphRelation, 'read' | 'write'> | undefined {
  if ((READ_SHAPED_TOOLS as readonly string[]).includes(toolName)) return 'read';
  if ((WRITE_SHAPED_TOOLS as readonly string[]).includes(toolName)) return 'write';
  return undefined;
}

/**
 * Body keys that carry a file path in the hook vocabulary. `tool_input`
 * carries `file_path`/`notebook_path`/`path` for the file-shaped tools
 * (hooks-contract.md §2 examples; the body passes through VERBATIM, so
 * unknown keys around these are normal). Top-level `file_path` is the
 * context-file event shape (`FileChanged` / `InstructionsLoaded`).
 */
const PATH_KEYS = Object.freeze(['file_path', 'notebook_path', 'path'] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract every ABSOLUTE file path from a hook `tool_input` (or any
 * record-shaped candidate). Non-absolute and non-string candidates are
 * dropped; duplicates collapse. Total over unknown — never throws on wire
 * data.
 */
export function absolutePathsFrom(candidate: unknown): readonly string[] {
  if (!isRecord(candidate)) return [];
  const paths = new Set<string>();
  for (const key of PATH_KEYS) {
    const value = candidate[key];
    if (typeof value === 'string' && value.startsWith('/')) paths.add(value);
  }
  return [...paths];
}
