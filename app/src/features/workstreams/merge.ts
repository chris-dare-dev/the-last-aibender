/**
 * FE-6 merge flow — the client half of the FROZEN merge verb (ws-protocol.md
 * §16.2/§16.3/§16.4): select N leaves → preview the conflict-surfacing merge
 * brief → dispatch ONE `workstream-merge-request` → correlate the fanned-out
 * `workstream-merge-resolved` (or a pushed §16.4 error) by mergeId.
 *
 * Client-side validation delegates to the FROZEN `validateWorkstreamClientMessage`
 * — the exact validator the broker runs — so anything this module refuses
 * (`blocked`) is precisely what the broker would answer `bad-request` to.
 * The server stays the authority for everything actually sent (unknown
 * parents / workstreams are RUNTIME state and only the broker can judge them).
 *
 * Wire-shape discipline: {@link buildMergeRequest} constructs the payload in
 * the golden corpus key order ({kind, mergeId, params:{parents, accountLabel,
 * backend, cwd, purpose, briefBody, workstreamId?}}) so an encoded envelope is
 * byte-comparable against `workstream-merge-request-valid` (§14 corpus device).
 *
 * [X2]: brief bodies carry file paths, harness session ids and placeholder
 * labels only. The preview assembler masks identity-shaped runs before any
 * draft text is seeded into the editor (defense in depth — the producer duty
 * stays with the broker side).
 */

import {
  validateWorkstreamClientMessage,
  type AccountLabel,
  type Backend,
  type ErrorCode,
  type WorkstreamBriefPayload,
  type WorkstreamMergeRequest,
} from '@aibender/protocol';
import { maskIdentityShapedText } from '../launch/index.ts';
import type { WorkstreamMergeSender } from './ports.ts';
import type { MergeState, WorkstreamsStore } from './store.ts';

export interface MergeDraft {
  /** 2..16 DISTINCT harness session ids (selection order preserved). */
  readonly parents: readonly string[];
  /** Placeholder label only [X2] — where the merge node runs. */
  readonly accountLabel: AccountLabel;
  /** Must satisfy the frozen label↔backend pairing. */
  readonly backend: Backend;
  /** Absolute working directory for the merge node. */
  readonly cwd: string;
  readonly purpose: string;
  /** The human-approved, conflict-surfacing merge brief (final text). */
  readonly briefBody: string;
  readonly workstreamId?: string;
}

/**
 * Golden-corpus key order — payload keys follow the fixture builders exactly
 * (outbound frames are byte-comparable against the corpus, lib/ws/outbound.ts).
 */
export function buildMergeRequest(draft: MergeDraft, mergeId: string): WorkstreamMergeRequest {
  return {
    kind: 'workstream-merge-request',
    mergeId,
    params: {
      parents: draft.parents,
      accountLabel: draft.accountLabel,
      backend: draft.backend,
      cwd: draft.cwd,
      purpose: draft.purpose,
      briefBody: draft.briefBody,
      ...(draft.workstreamId !== undefined ? { workstreamId: draft.workstreamId } : {}),
    },
  };
}

export type MergeDraftVerdict =
  | { readonly ok: true; readonly request: WorkstreamMergeRequest }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** Validate a draft through the FROZEN client-message validator. */
export function validateMergeDraft(draft: MergeDraft, mergeId: string): MergeDraftVerdict {
  const request = buildMergeRequest(draft, mergeId);
  const verdict = validateWorkstreamClientMessage(request);
  return verdict.ok
    ? { ok: true, request: verdict.value as WorkstreamMergeRequest }
    : { ok: false, code: verdict.code, message: verdict.message };
}

/**
 * Dispatch outcome — mirrors the store's {@link MergeState} phases for the
 * three local endings; wire endings (resolved/failed) land via bind.ts.
 */
export type DispatchOutcome = 'blocked' | 'unsendable' | 'pending';

export interface DispatchMergeOptions {
  readonly store: WorkstreamsStore;
  readonly sender: WorkstreamMergeSender | undefined;
}

/**
 * Validate → send → track. Never throws; every ending is a tracked
 * instrument state (the §16.4 error contract fills in `failed` later).
 */
export function dispatchMerge(
  draft: MergeDraft,
  mergeId: string,
  options: DispatchMergeOptions,
): DispatchOutcome {
  const track = (state: MergeState): void => options.store.getState().trackMerge(state);
  const verdict = validateMergeDraft(draft, mergeId);
  if (!verdict.ok) {
    track({ mergeId, phase: 'blocked', code: verdict.code, parents: draft.parents });
    return 'blocked';
  }
  const sent = options.sender?.sendWorkstreamMergeRequest(verdict.request) ?? false;
  if (!sent) {
    track({ mergeId, phase: 'unsendable', parents: draft.parents });
    return 'unsendable';
  }
  track({ mergeId, phase: 'pending', parents: draft.parents });
  return 'pending';
}

// ---------------------------------------------------------------------------
// Preview assembly — the conflict-surfacing brief editor seed
// ---------------------------------------------------------------------------

export interface MergePreviewParent {
  readonly sessionId: string;
  /** Latest brief distilling this parent, when one has arrived. */
  readonly briefId?: string;
  readonly briefKind?: WorkstreamBriefPayload['briefKind'];
  readonly provenance?: WorkstreamBriefPayload['provenance'];
  /** Masked first line of the brief body (never the raw wire text). */
  readonly excerpt?: string;
}

export interface MergePreview {
  /**
   * The broker-drafted merge brief matching this exact parent set
   * (provenance local-draft / refined — §16.2 draft flow), when one arrived.
   */
  readonly draft?: WorkstreamBriefPayload;
  readonly parents: readonly MergePreviewParent[];
  /** Editor seed: the draft body, else a conflict-surfacing scaffold. */
  readonly seededBody: string;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function latestBriefFor(
  sessionId: string,
  briefs: Readonly<Record<string, WorkstreamBriefPayload>>,
  briefOrder: readonly string[],
): WorkstreamBriefPayload | undefined {
  for (let i = briefOrder.length - 1; i >= 0; i -= 1) {
    const id = briefOrder[i];
    const brief = id === undefined ? undefined : briefs[id];
    if (brief === undefined) continue;
    if (brief.briefKind === 'merge') continue; // per-parent distillates only
    if (brief.sourceSessionIds.includes(sessionId)) return brief;
  }
  return undefined;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Assemble the merge preview for a selection: prefer the broker's drafted
 * merge brief for this exact parent set (newest wins); otherwise seed a
 * terse scaffold that FORCES the conflict section into view (blueprint §5:
 * merge = synthesis, not concatenation — conflicts surfaced explicitly).
 */
export function assembleMergePreview(
  selected: readonly string[],
  briefs: Readonly<Record<string, WorkstreamBriefPayload>>,
  briefOrder: readonly string[],
): MergePreview {
  let draft: WorkstreamBriefPayload | undefined;
  for (let i = briefOrder.length - 1; i >= 0; i -= 1) {
    const id = briefOrder[i];
    const brief = id === undefined ? undefined : briefs[id];
    if (brief === undefined || brief.briefKind !== 'merge') continue;
    if (sameIdSet([...brief.sourceSessionIds], selected)) {
      draft = brief;
      break;
    }
  }

  const parents: MergePreviewParent[] = selected.map((sessionId) => {
    const brief = latestBriefFor(sessionId, briefs, briefOrder);
    if (brief === undefined) return { sessionId };
    return {
      sessionId,
      briefId: brief.briefId,
      briefKind: brief.briefKind,
      provenance: brief.provenance,
      excerpt: maskIdentityShapedText(firstLine(brief.body)),
    };
  });

  const seededBody =
    draft !== undefined
      ? maskIdentityShapedText(draft.body)
      : [
          `merge brief: ${selected.length} parents`,
          ...parents.map((p) =>
            p.excerpt === undefined
              ? `- ${p.sessionId}: NO BRIEF RECORDED`
              : `- ${p.sessionId}: ${p.excerpt}`,
          ),
          'conflicts:',
          '- (surface disagreements between branches explicitly before dispatch)',
        ].join('\n');

  return {
    ...(draft !== undefined ? { draft } : {}),
    parents,
    seededBody,
  };
}
