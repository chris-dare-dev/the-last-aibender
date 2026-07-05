/**
 * Command registry — the palette is the PRIMARY verb surface (DESIGN.md §6).
 * Raycast grammar: verb-first fuzzy match, frequency-ranked. The kill-switch
 * rule (anything a mouse can do, the palette can do in two keystrokes) is
 * enforced by convention: every chrome affordance registers a command here,
 * and feature packages (FE-5/FE-6) register theirs through the same seam.
 */

import type { GatewayClient } from '../lib/ws/wsClient.ts';
import { channelOrder } from './theme/tokens.ts';
import { uiStore } from './uiStore.ts';

export interface CommandContext {
  readonly client: GatewayClient | undefined;
}

export interface CommandSpec {
  readonly id: string;
  /** Verb-first, terse, instrument voice ("open settings", not "Settings!"). */
  readonly title: string;
  /** Extra match corpus (never displayed). */
  readonly keywords?: string;
  run(ctx: CommandContext): void;
}

const registry = new Map<string, CommandSpec>();
const usage = new Map<string, number>();

const USAGE_KEY = 'ig-palette-usage';

/** Persistence exists only where a DOM does (Node's global is experimental). */
function storage(): Storage | undefined {
  return typeof document === 'undefined' ? undefined : globalThis.localStorage;
}

function loadUsage(): void {
  try {
    const raw = storage()?.getItem(USAGE_KEY);
    if (raw === null || raw === undefined) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number') usage.set(k, v);
    }
  } catch {
    /* frequency ranking is best-effort */
  }
}
loadUsage();

function persistUsage(): void {
  try {
    storage()?.setItem(USAGE_KEY, JSON.stringify(Object.fromEntries(usage)));
  } catch {
    /* best-effort */
  }
}

export function registerCommand(spec: CommandSpec): () => void {
  registry.set(spec.id, spec);
  return () => {
    registry.delete(spec.id);
  };
}

export function registerCommands(specs: readonly CommandSpec[]): () => void {
  const disposers = specs.map(registerCommand);
  return () => disposers.forEach((d) => d());
}

export function allCommands(): readonly CommandSpec[] {
  return [...registry.values()];
}

export function recordUse(id: string): void {
  usage.set(id, (usage.get(id) ?? 0) + 1);
  persistUsage();
}

/** Test hook: wipe registry + frequency state. */
export function resetCommandsForTest(): void {
  registry.clear();
  usage.clear();
}

/**
 * Subsequence fuzzy score: 0 = no match. Word-start and prefix hits score
 * higher; shorter titles win ties; frequency multiplies last.
 */
function fuzzyScore(query: string, corpus: string): number {
  if (query.length === 0) return 1;
  const q = query.toLowerCase();
  const c = corpus.toLowerCase();
  let score = 0;
  let ci = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q.charAt(qi);
    if (ch === ' ') continue;
    const found = c.indexOf(ch, ci);
    if (found === -1) return 0;
    // Contiguity + word-start bonuses.
    score += found === ci ? 3 : 1;
    if (found === 0 || c.charAt(found - 1) === ' ') score += 2;
    ci = found + 1;
  }
  return score + Math.max(0, 24 - c.length) / 24;
}

/** Rank commands for a palette query (frequency-weighted fuzzy match). */
export function rankCommands(query: string): readonly CommandSpec[] {
  const scored: { spec: CommandSpec; score: number }[] = [];
  for (const spec of registry.values()) {
    const corpus = spec.keywords === undefined ? spec.title : `${spec.title} ${spec.keywords}`;
    const base = fuzzyScore(query, corpus);
    if (base <= 0) continue;
    const freq = usage.get(spec.id) ?? 0;
    scored.push({ spec, score: base * (1 + Math.log1p(freq)) });
  }
  scored.sort((a, b) => b.score - a.score || a.spec.title.localeCompare(b.spec.title));
  return scored.map((s) => s.spec);
}

/** Chrome built-ins. Feature packages register their own verbs additively. */
export function builtinCommands(): readonly CommandSpec[] {
  const ui = uiStore.getState.bind(uiStore);
  return [
    {
      id: 'chrome.settings.open',
      title: 'open settings',
      keywords: 'preferences config',
      run: () => ui().openSettings(),
    },
    {
      id: 'chrome.approvals.focus',
      title: 'open approval inbox',
      keywords: 'permissions escalation allow deny',
      run: () => {
        document.getElementById('ig-approvals')?.scrollIntoView();
      },
    },
    {
      id: 'chrome.gateway.reconnect',
      title: 'reconnect gateway',
      keywords: 'broker retry discover',
      run: (ctx) => ctx.client?.retry(),
    },
    {
      id: 'chrome.instruments.toggle',
      title: 'toggle instruments overlay',
      keywords: 'right zone channels panels',
      run: () => ui().toggleInstrumentsOverlay(),
    },
    {
      // DESIGN.md §6 kill-switch rule: the work-surface GRAPH toggle
      // (WorkSurface.tsx header) must be reachable in two keystrokes.
      id: 'chrome.work.graph.toggle',
      title: 'toggle graph view',
      keywords: 'context graph island center work surface lineage',
      run: () => ui().toggleGraphView(),
    },
    ...channelOrder.map((channel) => ({
      id: `chrome.channel.focus.${channel}`,
      title: `focus channel ${channel}`,
      keywords: 'instrument panel account',
      run: () => ui().focusChannel(channel),
    })),
  ];
}
