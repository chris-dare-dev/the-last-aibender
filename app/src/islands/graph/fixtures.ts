/**
 * FE-4 fixture feed — deterministic, SYNTHESIZED `context-touch` scripts for
 * the live-population harness and the 5k-node soak (plan §9.2 FE-4 rows;
 * spike-B fps floor).
 *
 * Everything here is generated: paths live under `/synthetic/…`, session ids
 * are `ses-<n>` — no real project paths, no identity-bearing values ([X2]).
 *
 * Two generators:
 *  - {@link livePopulationWaves} — a small three-session script in WAVES, the
 *    shape of an active session touching files over time (the fixture-feed
 *    harness streams one wave at a time and asserts incremental growth);
 *  - {@link soakTouchScript} — an exact-count node/edge script for the 5k/8k
 *    ceiling (spike-B): S sessions + F files = nodes, F first-touches +
 *    C cross-touches = edges, all counts closed-form so the suite can assert
 *    the store lands on EXACTLY the target numbers.
 */

import type { ContextGraphRelation, ContextGraphTouch } from '@aibender/protocol';

/** Deterministic PRNG (mulberry32 — same family the store uses for jitter). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const touch = (
  sessionId: string,
  path: string,
  relation: ContextGraphRelation,
  ts: number,
): ContextGraphTouch => ({ kind: 'context-touch', sessionId, path, relation, ts });

/**
 * Live-population waves: three synthesized sessions touching instructions,
 * memory, produced artifacts and references — including RE-touches of
 * existing artifacts (pulse rows) and a cross-session touch (cluster edge).
 *
 * Wave shape (nodes/edges are cumulative store expectations):
 *   wave 0 → 4 nodes / 3 edges   (ses-alpha: CLAUDE.md, MEMORY.md, main.ts)
 *   wave 1 → 7 nodes / 6 edges   (ses-beta joins; re-touch of main.ts pulses)
 *   wave 2 → 10 nodes / 8 edges  (ses-gamma; write upgrades notes.md — the
 *                                 beta↔notes edge already exists, so only two
 *                                 new edges land)
 */
export function livePopulationWaves(startTs = 1_000): ContextGraphTouch[][] {
  let ts = startTs;
  const next = (): number => (ts += 10);
  return [
    [
      touch('ses-alpha', '/synthetic/proj-a/CLAUDE.md', 'instructions', next()),
      touch('ses-alpha', '/synthetic/proj-a/memory/MEMORY.md', 'read', next()),
      touch('ses-alpha', '/synthetic/proj-a/src/main.ts', 'read', next()),
    ],
    [
      // Re-touch: main.ts already exists → amber pulse for it ONLY.
      touch('ses-alpha', '/synthetic/proj-a/src/main.ts', 'read', next()),
      touch('ses-beta', '/synthetic/proj-a/src/main.ts', 'read', next()),
      touch('ses-beta', '/synthetic/proj-b/notes.md', 'read', next()),
      touch('ses-beta', '/synthetic/proj-b/spec.md', 'read', next()),
    ],
    [
      touch('ses-gamma', '/synthetic/proj-b/CLAUDE.md', 'instructions', next()),
      // Write on an existing reference → retag to agent-artifact + pulse.
      touch('ses-beta', '/synthetic/proj-b/notes.md', 'write', next()),
      touch('ses-gamma', '/synthetic/proj-b/out/report.md', 'write', next()),
    ],
  ];
}

export interface SoakScript {
  readonly touches: readonly ContextGraphTouch[];
  /** Exact node count the store must land on. */
  readonly nodeCount: number;
  /** Exact edge count the store must land on. */
  readonly edgeCount: number;
  readonly sessions: number;
  readonly files: number;
}

export interface SoakScriptOptions {
  /** Target TOTAL nodes (sessions + files). Default: the 5k ceiling. */
  nodes?: number;
  /** Target TOTAL edges (unique session↔file pairs). Default: 8k. */
  edges?: number;
  /** Sessions (clusters). Default 200 — the spike-B clustered-graph shape. */
  sessions?: number;
  seed?: number;
  startTs?: number;
}

/**
 * Exact-count soak script. With `nodes = S + F` and `edges = F + C`:
 * every file's FIRST touch comes from its owner session `ses-<f mod S>`
 * (creates the file node + one edge; the session nodes appear during the
 * first S of these), then C cross-touches hit EXISTING files from the
 * owner's neighbour session — each a new unique (session, file) pair (edge)
 * plus a pulse. Constraint: `C ≤ F` (one cross-touch per file suffices for
 * the 5k/8k shape: 3 200 ≤ 4 800).
 */
export function soakTouchScript(options: SoakScriptOptions = {}): SoakScript {
  const nodes = options.nodes ?? 5000;
  const edges = options.edges ?? 8000;
  const sessions = options.sessions ?? Math.min(200, Math.max(2, Math.floor(nodes / 25)));
  const files = nodes - sessions;
  const cross = edges - files;
  if (files <= 0) throw new Error(`soakTouchScript: nodes ${nodes} ≤ sessions ${sessions}`);
  if (cross < 0 || cross > files) {
    throw new Error(
      `soakTouchScript: edges ${edges} out of range [files ${files}, 2×files] for one-pass cross-touches`,
    );
  }

  const rng = mulberry32(options.seed ?? 42);
  let ts = options.startTs ?? 1_000;
  const touches: ContextGraphTouch[] = [];

  const pathOf = (f: number): string => {
    const proj = f % 23;
    // Deterministic kind spread: instructions files, memory files, produced
    // artifacts and plain references all appear (layer toggles get real
    // per-kind populations at the ceiling).
    // `mod-${f}` keeps CLAUDE.md paths UNIQUE per file index (23 projects
    // would otherwise collapse the 97-stride instruction files into
    // duplicate nodes and break the exact-count invariant).
    if (f % 97 === 0) return `/synthetic/proj-${proj}/mod-${f}/CLAUDE.md`;
    if (f % 89 === 0) return `/synthetic/proj-${proj}/memory/notes-${f}.md`;
    return `/synthetic/proj-${proj}/src/file-${f}.md`;
  };
  const relationOf = (f: number): ContextGraphRelation => {
    if (f % 97 === 0) return 'instructions';
    if (f % 7 === 0) return 'write';
    return rng() < 0.5 ? 'read' : 'watched';
  };

  for (let f = 0; f < files; f++) {
    touches.push(touch(`ses-${f % sessions}`, pathOf(f), relationOf(f), (ts += 1)));
  }
  for (let c = 0; c < cross; c++) {
    const f = c; // each file at most once → pair uniqueness by construction
    const neighbour = ((f % sessions) + 1) % sessions;
    touches.push(touch(`ses-${neighbour}`, pathOf(f), 'read', (ts += 1)));
  }

  return { touches, nodeCount: nodes, edgeCount: edges, sessions, files };
}

/** Slice a script into feed chunks (streaming shape for harnesses). */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunked: size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}
