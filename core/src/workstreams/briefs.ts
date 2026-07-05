/**
 * Brief synthesis (BE-7; plan §4/BE-7 item 2, blueprint §5 "merge =
 * synthesis, not concatenation"):
 *
 *   - DISTILLATION per source node: prefer the cheapest sound source — the
 *     transcript's own native compaction summary where present
 *     ({@link extractNativeCompactionSummary}, provenance `native-summary`);
 *     else a LOCAL-MODEL first draft through BE-4's LM Studio adapter
 *     ({@link lmStudioBriefDrafter}, provenance `local-draft`), optionally
 *     refined by a Claude pass behind {@link BriefRefinerPort} (provenance
 *     `refined`) — the qwen-produces/Claude-reviews split. DOWN IS A STATE:
 *     an unreachable local model degrades to a deterministic harness
 *     template, never an exception and never a paid-model call (tests run
 *     fakes only; the live local path is runtime-only).
 *
 *   - CONFLICT SURFACING is HARNESS-SIDE and deterministic: `key: value`
 *     claims are extracted from each branch distillate and disagreeing keys
 *     are rendered into an explicit `## Conflicts` section
 *     ({@link surfaceConflicts}). The section is composed AFTER any model
 *     pass, structurally — no model (local or otherwise) can silently
 *     resolve a disagreement out of the merge brief.
 *
 * [X2]: brief bodies carry file paths + harness session ids + placeholder
 * labels only. Nothing in this module reads a native session id.
 */

import type { BriefProvenance } from '@aibender/protocol';

import type { LmStudioClient } from '../adapters/lmstudio/index.js';

// ---------------------------------------------------------------------------
// Ports (the qwen-produces / Claude-reviews split, both fake-tested)
// ---------------------------------------------------------------------------

export interface BriefDraftRequest {
  /** What the draft is for (e.g. 'continuation brief', 'merge brief'). */
  readonly goal: string;
  /** Harness session ids the material came from (cited in the draft). */
  readonly sourceSessionIds: readonly string[];
  /** The material to distill (transcript slice / distillates). Memory-only. */
  readonly material: string;
}

export type BriefDraftResult =
  | { readonly state: 'ok'; readonly body: string }
  /** The local model is down — a STATE, never an error (blueprint §4.3). */
  | { readonly state: 'down' }
  | { readonly state: 'error'; readonly message: string };

/** The PRODUCER: local-model first drafts (LM Studio via BE-4, never paid). */
export interface BriefDrafterPort {
  draft(request: BriefDraftRequest): Promise<BriefDraftResult>;
}

/**
 * The REVIEWER: the Claude refinement pass over a local draft. Wiring a real
 * implementation is a RUNTIME composition concern (cost-incurring inference
 * is forbidden in tests — fakes only); absent → drafts stand as
 * `local-draft`.
 */
export interface BriefRefinerPort {
  refine(draftBody: string, request: BriefDraftRequest): Promise<BriefDraftResult>;
}

/** A produced brief body plus the provenance that names how it was made. */
export interface SynthesizedBrief {
  readonly body: string;
  readonly provenance: BriefProvenance;
}

// ---------------------------------------------------------------------------
// Native compaction-summary reuse (x4-workstreams: the transcript already
// carries the continuation brief — reuse beats regenerating)
// ---------------------------------------------------------------------------

/**
 * The synthetic post-compaction user message's opening line (observed local
 * ground truth, x4-workstreams "Compaction (what actually happens)").
 */
export const NATIVE_COMPACTION_SUMMARY_PREFIX =
  'This session is being continued from a previous conversation';

function textOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : undefined,
      )
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * Extract the LAST native compaction summary from transcript JSONL text:
 * the synthetic user message that follows a `compact_boundary` record (or
 * any user message opening with the known continuation prefix). Malformed
 * lines are skipped — the scan always completes (the tailer posture).
 */
export function extractNativeCompactionSummary(jsonlText: string): string | undefined {
  let latest: string | undefined;
  for (const line of jsonlText.split('\n')) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const rec = record as Record<string, unknown>;
    if (rec['type'] !== 'user') continue;
    const message = rec['message'];
    const content =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)['content']
        : rec['content'];
    const text = textOfContent(content);
    if (text !== undefined && text.startsWith(NATIVE_COMPACTION_SUMMARY_PREFIX)) {
      latest = text;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Deterministic conflict surfacing (never model-resolved)
// ---------------------------------------------------------------------------

export interface BranchDistillate {
  /** Harness session id of the branch leaf. */
  readonly sessionId: string;
  readonly body: string;
}

export interface SurfacedConflict {
  /** The claim key both branches speak to (e.g. `approach`). */
  readonly key: string;
  /** sessionId → that branch's claimed value. */
  readonly claims: readonly { readonly sessionId: string; readonly value: string }[];
}

const CLAIM_LINE_RE = /^[-*\s]*([A-Za-z][A-Za-z0-9 _/-]{0,63}?)\s*:\s*(.+)$/;

/** Extract `key: value` claim lines from one distillate (lower-cased keys). */
export function extractClaims(body: string): ReadonlyMap<string, string> {
  const claims = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = CLAIM_LINE_RE.exec(line.trim());
    if (match === null) continue;
    const key = (match[1] ?? '').trim().toLowerCase();
    const value = (match[2] ?? '').trim();
    if (key.length === 0 || value.length === 0) continue;
    claims.set(key, value);
  }
  return claims;
}

/**
 * Compare per-branch claims: any key claimed by ≥2 branches with differing
 * values is a conflict — surfaced verbatim per branch, never resolved.
 */
export function surfaceConflicts(branches: readonly BranchDistillate[]): readonly SurfacedConflict[] {
  const byKey = new Map<string, { sessionId: string; value: string }[]>();
  for (const branch of branches) {
    for (const [key, value] of extractClaims(branch.body)) {
      const entry = byKey.get(key) ?? [];
      entry.push({ sessionId: branch.sessionId, value });
      byKey.set(key, entry);
    }
  }
  const conflicts: SurfacedConflict[] = [];
  for (const [key, claims] of byKey) {
    if (claims.length < 2) continue;
    const distinct = new Set(claims.map((claim) => claim.value));
    if (distinct.size < 2) continue;
    conflicts.push({ key, claims });
  }
  return conflicts.sort((a, b) => a.key.localeCompare(b.key));
}

/** Render the structural conflicts section (appended after any model pass). */
export function renderConflictsSection(conflicts: readonly SurfacedConflict[]): string {
  if (conflicts.length === 0) return '';
  const lines: string[] = ['## Conflicts (surfaced, unresolved — decide before proceeding)'];
  for (const conflict of conflicts) {
    lines.push(`- **${conflict.key}** disagrees across branches:`);
    for (const claim of conflict.claims) {
      lines.push(`  - \`${claim.sessionId}\`: ${claim.value}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Synthesis pipeline
// ---------------------------------------------------------------------------

export interface BriefSynthesizerOptions {
  /** The local-model producer. Absent → deterministic fallback only. */
  readonly drafter?: BriefDrafterPort;
  /** The Claude reviewer. Absent → local drafts stand as `local-draft`. */
  readonly refiner?: BriefRefinerPort;
}

export interface BriefSynthesizer {
  /**
   * One node's continuation/snapshot distillate: native summary reuse when
   * the transcript text carries one, else drafter (+refiner), else the
   * deterministic fallback. NEVER rejects.
   */
  distill(input: {
    readonly goal: string;
    readonly sessionId: string;
    /** Transcript text when available (read-only read upstream). */
    readonly transcriptText?: string;
    /** Extra deterministic context lines (paths + ids + labels only [X2]). */
    readonly contextLines?: readonly string[];
  }): Promise<SynthesizedBrief>;
  /**
   * The conflict-surfacing merge synthesis over per-branch distillates
   * (blueprint §5). The conflicts section is appended STRUCTURALLY after
   * any model output. NEVER rejects.
   */
  synthesizeMergeBrief(input: {
    readonly branches: readonly BranchDistillate[];
  }): Promise<SynthesizedBrief>;
}

function fallbackBody(goal: string, sessionIds: readonly string[], contextLines: readonly string[]): string {
  return [
    `# ${goal}`,
    '',
    `Sources: ${sessionIds.join(', ')}`,
    ...(contextLines.length > 0 ? ['', ...contextLines] : []),
    '',
    '_Deterministic harness fallback (local model unavailable — down is a state)._',
  ].join('\n');
}

export function createBriefSynthesizer(options: BriefSynthesizerOptions = {}): BriefSynthesizer {
  const draftThenRefine = async (
    request: BriefDraftRequest,
    fallback: string,
  ): Promise<SynthesizedBrief> => {
    if (options.drafter === undefined) {
      return { body: fallback, provenance: 'local-draft' };
    }
    let drafted: BriefDraftResult;
    try {
      drafted = await options.drafter.draft(request);
    } catch {
      drafted = { state: 'error', message: 'drafter rejected' };
    }
    if (drafted.state !== 'ok' || drafted.body.trim().length === 0) {
      return { body: fallback, provenance: 'local-draft' };
    }
    if (options.refiner === undefined) {
      return { body: drafted.body, provenance: 'local-draft' };
    }
    let refined: BriefDraftResult;
    try {
      refined = await options.refiner.refine(drafted.body, request);
    } catch {
      refined = { state: 'error', message: 'refiner rejected' };
    }
    if (refined.state !== 'ok' || refined.body.trim().length === 0) {
      return { body: drafted.body, provenance: 'local-draft' };
    }
    return { body: refined.body, provenance: 'refined' };
  };

  return {
    distill: async (input) => {
      const contextLines = input.contextLines ?? [];
      if (input.transcriptText !== undefined) {
        const native = extractNativeCompactionSummary(input.transcriptText);
        if (native !== undefined) {
          // Reuse beats regenerating (plan §9.2 BE-7 edge row).
          return { body: native, provenance: 'native-summary' };
        }
      }
      const material = [
        ...contextLines,
        ...(input.transcriptText !== undefined ? [input.transcriptText] : []),
      ].join('\n');
      return draftThenRefine(
        {
          goal: input.goal,
          sourceSessionIds: [input.sessionId],
          material,
        },
        fallbackBody(input.goal, [input.sessionId], contextLines),
      );
    },

    synthesizeMergeBrief: async (input) => {
      const conflicts = renderConflictsSection(surfaceConflicts(input.branches));
      const material = input.branches
        .map((branch) => `### Branch ${branch.sessionId}\n${branch.body}`)
        .join('\n\n');
      const sessionIds = input.branches.map((branch) => branch.sessionId);
      const synthesized = await draftThenRefine(
        {
          goal: 'merge brief (fuse branch distillates; keep disagreements explicit)',
          sourceSessionIds: sessionIds,
          material,
        },
        fallbackBody('Merge brief', sessionIds, [material]),
      );
      // STRUCTURAL conflict surfacing: appended after any model pass so a
      // draft can never silently resolve a disagreement.
      const body =
        conflicts.length > 0 ? `${synthesized.body}\n\n${conflicts}` : synthesized.body;
      return { body, provenance: synthesized.provenance };
    },
  };
}

// ---------------------------------------------------------------------------
// BE-4 adapter binding (the classification-queue precedent, readmodels)
// ---------------------------------------------------------------------------

export const BRIEF_DRAFT_SYSTEM_PROMPT =
  'You distill an AI coding session into a continuation brief. Output concise ' +
  'markdown: goals, decisions (as `key: value` lines), files touched (absolute ' +
  'paths), pending work. Cite only the provided session ids. Never invent ' +
  'emails, usernames, or account identifiers.';

export interface LmStudioBriefDrafterOptions {
  /** BE-4's LM Studio `/v1` client — the ONLY inference path used. */
  readonly client: LmStudioClient;
  /** Local model key to route to (≤8B Q4 default tier). */
  readonly model: string;
  readonly maxTokens?: number;
}

/** The PRODUCER bound to BE-4's adapter: down-as-state, never throws. */
export function lmStudioBriefDrafter(options: LmStudioBriefDrafterOptions): BriefDrafterPort {
  return {
    draft: async (request) => {
      const result = await options.client.chat({
        model: options.model,
        messages: [
          { role: 'system', content: BRIEF_DRAFT_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `Goal: ${request.goal}\n` +
              `Sessions: ${request.sourceSessionIds.join(', ')}\n\n` +
              request.material,
          },
        ],
        maxTokens: options.maxTokens ?? 1024,
        temperature: 0,
      });
      if (result.state === 'down') return { state: 'down' };
      if (result.state === 'error') {
        return { state: 'error', message: result.message };
      }
      const body = result.value.content.trim();
      return body.length > 0
        ? { state: 'ok', body }
        : { state: 'error', message: 'empty local draft' };
    },
  };
}
