/**
 * `workstream` channel payloads + the X4 lineage port types — the wire and
 * seam half of the blueprint §5 workstreams model (plan §4/BE-7, §5/FE-6,
 * findings x4-workstreams Option B + Option E slice).
 *
 * WIRE (the `workstream` channel, registered at this freeze — channels.ts):
 *   broker → client (fan-out, replayable §8):
 *     - `workstream-list-snapshot`    the workstream rail (summaries + the
 *                                     detached-HEAD orphan count)
 *     - `workstream-detail-snapshot`  one workstream's nodes + edges (or the
 *                                     detached bucket, scope matrix below)
 *     - `workstream-node`             node UPSERT keyed on sessionId
 *     - `workstream-edge`             edge APPEND keyed on edgeId (edges are
 *                                     immutable once recorded)
 *     - `workstream-brief`            a brief body (paths + session ids +
 *                                     labels only [X2] — producer duty, the
 *                                     approvals-summary precedent)
 *     - `branch-advisory`             the context-pressure "branch now"
 *                                     proposal (~70%, blueprint §5)
 *     - `workstream-merge-resolved`   merge landed; correlates by mergeId
 *   client → broker:
 *     - `workstream-merge-request`    the ONE lineage verb the FE sends —
 *                                     merge = ONE new node with N
 *                                     `merge_parent` edges seeded by a
 *                                     conflict-surfacing brief (blueprint §5
 *                                     "merge = synthesis, not concatenation");
 *                                     failures answer PUSHED errors with
 *                                     `correlatesTo: mergeId` (codes below)
 *     - the generic `replay-request` (replay.ts)
 *
 *   Merge error codes (frozen): `bad-request` (shape), `session-not-found`
 *   (a named parent has no session node — also the degrade answer of a
 *   broker with no lineage engine composed), `workstream-not-found` (the
 *   named workstreamId is unknown — errors.ts, added at this freeze),
 *   `internal`. Success is the fanned-out `workstream-merge-resolved`.
 *
 * FORWARD-TOLERANT READER (same frozen rule as `events`, §13.3): a broker
 * push on `workstream` whose `kind` is a non-empty string OUTSIDE the frozen
 * set is legal and MUST be ignored (decoded as
 * {@link OpaqueWorkstreamPayload}) — M5 pipeline lenses land without breaking
 * M4 clients. Registered kinds validate STRICTLY.
 *
 * IDENTITY DISCIPLINE [X2]: payloads carry harness session ids, file paths,
 * and placeholder account labels ONLY. Native session ids NEVER ride this
 * channel (the event-summary precedent) — the native id is a nullable STORE
 * attribute (sqlite-ddl.md migration 0003).
 *
 * SEAMS (frozen port types, consumed across lanes):
 *   - {@link LineageRecorder} — the kernel-facing edge-recording interface
 *     BE-1/BE-2 call on EVERY launch / resume / fork / recycle / merge, at
 *     action time, deterministically (blueprint §5 recording discipline).
 *     Generalizes the M2 `ContinuationEdgeEmitter` stub
 *     (core/src/kernel/pty/ptyHost.ts) — a recycle is the `recycle` action
 *     here; same-node recycles carry fromSessionId === toSessionId. BE-7
 *     implements it over @aibender/schema's lineage store; the composition
 *     root injects it; {@link noopLineageRecorder} is the M1–M3 behavior.
 *     The reconciler handles EXTERNAL sessions only — it never rides this
 *     port.
 *   - {@link SessionIdResolver} — the native→harness session-id mapping the
 *     composition root MUST inject into the graphfeed at M4 (ws-protocol.md
 *     §12 pin; the `resolveSessionId` seam in
 *     core/src/collector/graphfeed/hookTouches.ts): return the harness id
 *     where the ledger knows one, return the input to relay the native id
 *     verbatim (charset-validated downstream, never rewritten), return
 *     undefined to drop.
 *
 * ============================================================================
 * FROZEN-M4 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import { isSessionIdSegment } from './channels.js';
import type { AccountLabel, Backend } from './vocab.js';

// ---------------------------------------------------------------------------
// Vocabularies (shared with @aibender/schema migration 0003 CHECKs)
// ---------------------------------------------------------------------------

/** Workstream lifecycle states (blueprint §5 `workstream.status`). */
export const WORKSTREAM_STATUSES = Object.freeze([
  'active',
  'paused',
  'merged',
  'archived',
  'abandoned',
] as const);

export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

export function isWorkstreamStatus(value: unknown): value is WorkstreamStatus {
  return typeof value === 'string' && (WORKSTREAM_STATUSES as readonly string[]).includes(value);
}

/**
 * Session-node lineage states (x4-workstreams §3.1 — DISTINCT from the
 * resume-ledger process states, vocab.ts). `unresumable` = the 30-day native
 * cleanup or a `/cd` move broke resumability (blueprint §5 guardrail);
 * `external` = a reconciled session whose liveness the harness cannot judge.
 */
export const SESSION_NODE_STATES = Object.freeze([
  'running',
  'idle',
  'completed',
  'abandoned',
  'unresumable',
  'external',
] as const);

export type SessionNodeState = (typeof SESSION_NODE_STATES)[number];

export function isSessionNodeState(value: unknown): value is SessionNodeState {
  return typeof value === 'string' && (SESSION_NODE_STATES as readonly string[]).includes(value);
}

/**
 * The FROZEN edge-type vocabulary — exactly the blueprint §5 set. A
 * continuation is a CHILD via `continue` (never a sibling); a merge is ONE
 * new node with N `merge_parent` edges; `handoff` is a cross-account /
 * cross-backend continue whose brief is MANDATORY; `workflow` edges are the
 * M5 pipeline engine's step registrations.
 */
export const SESSION_EDGE_TYPES = Object.freeze([
  'continue',
  'fork',
  'merge_parent',
  'compact',
  'sidechain',
  'handoff',
  'import',
  'workflow',
] as const);

export type SessionEdgeType = (typeof SESSION_EDGE_TYPES)[number];

export function isSessionEdgeType(value: unknown): value is SessionEdgeType {
  return typeof value === 'string' && (SESSION_EDGE_TYPES as readonly string[]).includes(value);
}

/**
 * Recording confidence (blueprint §5): `recorded` = deterministic,
 * action-time, via {@link LineageRecorder} (or a native first-class lineage
 * column like opencode `parent_id`); `inferred` = reconciler heuristics over
 * externally created sessions.
 */
export const LINEAGE_CONFIDENCES = Object.freeze(['recorded', 'inferred'] as const);

export type LineageConfidence = (typeof LINEAGE_CONFIDENCES)[number];

export function isLineageConfidence(value: unknown): value is LineageConfidence {
  return typeof value === 'string' && (LINEAGE_CONFIDENCES as readonly string[]).includes(value);
}

/** Who created the node row (blueprint §5 `session_node.origin`). */
export const SESSION_NODE_ORIGINS = Object.freeze(['harness', 'reconciled'] as const);

export type SessionNodeOrigin = (typeof SESSION_NODE_ORIGINS)[number];

export function isSessionNodeOrigin(value: unknown): value is SessionNodeOrigin {
  return typeof value === 'string' && (SESSION_NODE_ORIGINS as readonly string[]).includes(value);
}

/**
 * Brief kinds — the M4 freeze names them by the AUTOMATION MOMENT that
 * produces them (hooks-contract.md §3 [X4] rows):
 *   session-end              → the auto continuation brief (SessionEnd hook)
 *   pre-compact              → the full-fidelity pre-compaction snapshot
 *   session-start-injection  → the brief body injected into a starting
 *                              session (SessionStart hook response)
 *   merge                    → the conflict-surfacing merge brief
 * (The blueprint's continuation/compaction_capture/handoff/merge naming maps
 * onto these: continuation→session-end, compaction_capture→pre-compact,
 * handoff briefs are session-end briefs carried by a handoff edge, merge→merge.)
 */
export const BRIEF_KINDS = Object.freeze([
  'session-end',
  'pre-compact',
  'session-start-injection',
  'merge',
] as const);

export type BriefKind = (typeof BRIEF_KINDS)[number];

export function isBriefKind(value: unknown): value is BriefKind {
  return typeof value === 'string' && (BRIEF_KINDS as readonly string[]).includes(value);
}

/**
 * Brief provenance (blueprint §5 merge semantics — the qwen-produces /
 * Claude-reviews split): `native-summary` reuses the transcript's own
 * compaction summary; `local-draft` is the local-model first draft;
 * `refined` is a draft after the Claude refinement pass (or human editing).
 */
export const BRIEF_PROVENANCES = Object.freeze([
  'native-summary',
  'local-draft',
  'refined',
] as const);

export type BriefProvenance = (typeof BRIEF_PROVENANCES)[number];

export function isBriefProvenance(value: unknown): value is BriefProvenance {
  return typeof value === 'string' && (BRIEF_PROVENANCES as readonly string[]).includes(value);
}

/**
 * Lineage entity ids on the wire (workstreamId / edgeId / briefId) use the
 * SAME conservative segment rule as session ids: 1–64 chars of
 * [A-Za-z0-9_-]. Harness-minted (`ws_…` / `edg_…` / `br_…`), never native.
 */
export function isLineageIdSegment(value: unknown): value is string {
  return isSessionIdSegment(value);
}

/** Client-generated merge correlation id — same rule as control request ids. */
export const MERGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Bounds on the merge parent set: N `merge_parent` edges, N in 2..16. */
export const MERGE_MIN_PARENTS = 2;
export const MERGE_MAX_PARENTS = 16;

// ---------------------------------------------------------------------------
// Wire records (shared by snapshots and events)
// ---------------------------------------------------------------------------

/** One workstream as it appears on the rail (list snapshot entries). */
export interface WorkstreamSummary {
  readonly workstreamId: string;
  /** Identifier-free title [X2]. */
  readonly title: string;
  readonly status: WorkstreamStatus;
  /** Optional tag strings (identifier-free [X2]). */
  readonly tags?: readonly string[];
  /** Session nodes currently assigned to this workstream. */
  readonly nodeCount: number;
  /** Epoch ms of the last workstream/node mutation. */
  readonly updatedAt: number;
}

/**
 * One lineage node. UPSERT semantics on the `workstream-node` event: keyed
 * on `sessionId`, fired on registration AND on attribute change (state,
 * workstream assignment, snapshots). Carries the HARNESS session id only —
 * native ids stay in the store [X2].
 */
export interface WorkstreamNodeRecord {
  /** Harness session id — the resume-ledger id for kernel-launched sessions. */
  readonly sessionId: string;
  /** Absent = the detached-HEAD orphan bucket. */
  readonly workstreamId?: string;
  readonly backend: Backend;
  /** Placeholder label only [X2]; must satisfy the label↔backend pairing. */
  readonly account: AccountLabel;
  readonly state: SessionNodeState;
  readonly origin: SessionNodeOrigin;
  readonly confidence: LineageConfidence;
  /** Identifier-free display name [X2], when one exists. */
  readonly displayName?: string;
  /** Absolute working directory (paths are legal on this wire [X2]). */
  readonly cwd?: string;
  readonly gitBranch?: string;
  /** Token/cost snapshots for the node card (blueprint §5). */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Always an ESTIMATE (prices-table math) — actuals live in the events store. */
  readonly costEstimatedUsd?: number;
  /** Epoch ms the node was recorded. */
  readonly createdAt: number;
  /** Epoch ms of the last observed activity. */
  readonly lastActiveAt?: number;
}

/**
 * One lineage edge. APPEND semantics on the `workstream-edge` event: keyed
 * on `edgeId`; edges are immutable once recorded. `fromSessionId` is
 * REQUIRED for every edge type EXCEPT `import` (where it is FORBIDDEN —
 * imports have no in-graph parent, x4-workstreams §3.1).
 */
export interface WorkstreamEdgeRecord {
  readonly edgeId: string;
  readonly fromSessionId?: string;
  readonly toSessionId: string;
  readonly edgeType: SessionEdgeType;
  /** The brief carried across, when one exists (MANDATORY for `handoff`). */
  readonly briefId?: string;
  readonly confidence: LineageConfidence;
  /** Epoch ms the edge was recorded (action time for `recorded` edges). */
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Broker → client payloads
// ---------------------------------------------------------------------------

export interface WorkstreamListSnapshot {
  readonly kind: 'workstream-list-snapshot';
  /** Epoch ms. */
  readonly capturedAt: number;
  readonly workstreams: readonly WorkstreamSummary[];
  /** Nodes in the detached-HEAD bucket (reconciled, unassigned). */
  readonly detachedNodeCount: number;
}

/**
 * One workstream's full graph — or the detached-HEAD bucket. Scope matrix
 * (validated): scope `workstream` REQUIRES the `workstream` summary; scope
 * `detached` FORBIDS it (the approvals §10.1 per-source matrix precedent).
 */
export interface WorkstreamDetailSnapshot {
  readonly kind: 'workstream-detail-snapshot';
  /** Epoch ms. */
  readonly capturedAt: number;
  readonly scope: 'workstream' | 'detached';
  readonly workstream?: WorkstreamSummary;
  readonly nodes: readonly WorkstreamNodeRecord[];
  readonly edges: readonly WorkstreamEdgeRecord[];
}

export interface WorkstreamNodeEvent extends WorkstreamNodeRecord {
  readonly kind: 'workstream-node';
}

export interface WorkstreamEdgeEvent extends WorkstreamEdgeRecord {
  readonly kind: 'workstream-edge';
}

/**
 * A brief body on the wire. [X2]: `body` carries file paths, harness session
 * ids, and placeholder labels ONLY — the producer redacts before publishing
 * (the frozen approvals-summary duty, validated in prose, screened by the
 * corpus fixture policy).
 */
export interface WorkstreamBriefPayload {
  readonly kind: 'workstream-brief';
  readonly briefId: string;
  readonly briefKind: BriefKind;
  /** Markdown, non-empty. */
  readonly body: string;
  /** The nodes this brief distills — non-empty, harness session ids. */
  readonly sourceSessionIds: readonly string[];
  readonly provenance: BriefProvenance;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly workstreamId?: string;
}

/**
 * The context-pressure watch's "branch now" proposal (blueprint §5 handoff
 * automation: surfaced at ~70% context use — the threshold is broker
 * configuration, the EVENT is the contract).
 */
export interface BranchAdvisory {
  readonly kind: 'branch-advisory';
  /** Harness session id of the pressured session. */
  readonly sessionId: string;
  /** 0..100 inclusive (honesty pin: validated, like quota usedPct). */
  readonly contextUsedPct: number;
  /** Epoch ms. */
  readonly ts: number;
}

/** Merge landed: the new node exists and its edges/brief were fanned out. */
export interface WorkstreamMergeResolved {
  readonly kind: 'workstream-merge-resolved';
  /** Correlates to the client's `workstream-merge-request`. */
  readonly mergeId: string;
  /** The NEW merge node's harness session id. */
  readonly sessionId: string;
  /** The merge brief seeded into the node. */
  readonly briefId: string;
}

export type WorkstreamServerPayload =
  | WorkstreamListSnapshot
  | WorkstreamDetailSnapshot
  | WorkstreamNodeEvent
  | WorkstreamEdgeEvent
  | WorkstreamBriefPayload
  | BranchAdvisory
  | WorkstreamMergeResolved;

/** Registered broker→client kinds (unknown kinds decode opaque — see below). */
export const WORKSTREAM_SERVER_PAYLOAD_KINDS = Object.freeze([
  'workstream-list-snapshot',
  'workstream-detail-snapshot',
  'workstream-node',
  'workstream-edge',
  'workstream-brief',
  'branch-advisory',
  'workstream-merge-resolved',
] as const);

/**
 * Decoded form of a workstream payload whose `kind` is outside the frozen
 * set: legal by the forward-tolerant reader rule; clients MUST ignore it.
 * The `opaque` marker is decode-side only — it never rides the wire.
 */
export interface OpaqueWorkstreamPayload {
  readonly kind: string;
  readonly opaque: true;
}

// ---------------------------------------------------------------------------
// Client → broker: the merge request
// ---------------------------------------------------------------------------

export interface WorkstreamMergeParams {
  /**
   * The leaves being merged: 2..16 DISTINCT harness session ids, each an
   * existing session node. Unknown parents answer `session-not-found`.
   */
  readonly parents: readonly string[];
  /** Where the merge node runs. Placeholder label only [X2]. */
  readonly accountLabel: AccountLabel;
  /** Must satisfy the frozen label↔backend pairing. */
  readonly backend: Backend;
  /** Absolute working directory for the merge node. */
  readonly cwd: string;
  /** Free-text purpose, lands in the resume ledger row-before-spawn. */
  readonly purpose: string;
  /**
   * The human-approved, conflict-surfacing merge brief body (markdown,
   * non-empty — merge briefs are MANDATORY, blueprint §5). Drafts flow to
   * the editor as `workstream-brief` payloads (provenance local-draft /
   * refined); the wire carries the FINAL text. Paths + session ids + labels
   * only [X2].
   */
  readonly briefBody: string;
  /** Assign the merge node to a workstream; unknown → `workstream-not-found`. */
  readonly workstreamId?: string;
}

export interface WorkstreamMergeRequest {
  readonly kind: 'workstream-merge-request';
  /** Client-generated correlation id ({@link MERGE_ID_RE}); pushed errors carry it as `correlatesTo`. */
  readonly mergeId: string;
  readonly params: WorkstreamMergeParams;
}

export type WorkstreamClientPayload = WorkstreamMergeRequest;

// ---------------------------------------------------------------------------
// Frozen seam: the kernel-facing lineage recorder (blueprint §5 recording
// discipline — "edges are recorded deterministically at action time")
// ---------------------------------------------------------------------------

/** A new node exists: the kernel launched a session (row-before-spawn). */
export interface LineageLaunchAction {
  readonly kind: 'launch';
  /** The new node's harness session id (the resume-ledger id). */
  readonly sessionId: string;
  readonly accountLabel: AccountLabel;
  readonly backend: Backend;
  /** Absolute working directory (a node ATTRIBUTE, blueprint §5). */
  readonly cwd: string;
  /** The launch params' optional X4 hint (workstream id or slug). */
  readonly workstreamHint?: string;
  readonly atEpochMs: number;
}

/**
 * A `continue` edge: un-forked resume. A continuation is a CHILD — when the
 * resume re-drives the SAME node (dead-resume in place),
 * fromSessionId === toSessionId (the M2 ContinuationEdgeEmitter convention).
 */
export interface LineageResumeAction {
  readonly kind: 'resume';
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly atEpochMs: number;
}

/** A `fork` edge: sibling-creating CHILD from the fork point. */
export interface LineageForkAction {
  readonly kind: 'fork';
  readonly fromSessionId: string;
  /** The fork CHILD's harness session id (never the parent). */
  readonly toSessionId: string;
  readonly atEpochMs: number;
}

/**
 * A `continue` edge via checkpoint (kill graceful → checkpoint →
 * continuation; blueprint §4.1 recycle path). Same-node recycles carry
 * fromSessionId === toSessionId; fork recycles point at the child row.
 */
export interface LineageRecycleAction {
  readonly kind: 'recycle';
  readonly fromSessionId: string;
  readonly toSessionId: string;
  /** Opaque checkpoint reference (path or journal locator), when one exists. */
  readonly checkpointRef?: string;
  readonly atEpochMs: number;
}

/** N `merge_parent` edges into ONE new node (blueprint §5 merge semantics). */
export interface LineageMergeAction {
  readonly kind: 'merge';
  /** 2..16 distinct parent harness session ids. */
  readonly parentSessionIds: readonly string[];
  /** The NEW merge node's harness session id. */
  readonly toSessionId: string;
  /** The merge brief seeding the node, once persisted. */
  readonly briefId?: string;
  readonly atEpochMs: number;
}

export type LineageAction =
  | LineageLaunchAction
  | LineageResumeAction
  | LineageForkAction
  | LineageRecycleAction
  | LineageMergeAction;

/**
 * THE kernel-facing edge-recording port (frozen at M4). BE-1/BE-2 call
 * `record` on every launch / resume / fork / recycle / merge AT ACTION TIME;
 * BE-7 implements it over the @aibender/schema lineage store; the
 * composition root injects it. Contract:
 *
 *   - `record` is fire-and-forget for the CALLER: it MUST NOT throw on any
 *     input (a throwing recorder is a recorder bug — implementations log and
 *     swallow), and the kernel path never awaits it.
 *   - Recording is DETERMINISTIC: every kernel-mediated action produces its
 *     typed node/edge exactly once, `confidence: 'recorded'`. The reconciler
 *     covers EXTERNAL sessions only and never rides this port.
 *   - Generalizes the M2 `ContinuationEdgeEmitter` stub (a recycle
 *     continuation is `{ kind: 'recycle', … }` here); the composition root
 *     adapts the ptyHost stub onto this port.
 */
export interface LineageRecorder {
  record(action: LineageAction): void;
}

/** The M1–M3 behavior: nothing is recorded (the frozen default). */
export const noopLineageRecorder: LineageRecorder = Object.freeze({
  record: () => undefined,
});

// ---------------------------------------------------------------------------
// Frozen seam: the ledger session-id resolver (ws-protocol.md §12 M4 pin)
// ---------------------------------------------------------------------------

/**
 * Native → harness session-id mapping, injected by the composition root into
 * every native-id-bearing feed (graphfeed `resolveSessionId`, the hooks
 * approvals relay `sessionIdOfNative`). Frozen semantics:
 *
 *   - return the HARNESS session id where the ledger knows the native id;
 *   - return the INPUT VERBATIM to relay the native id (external sessions
 *     stay visible under their native id until the reconciler registers
 *     them; ids are charset-validated downstream, never rewritten);
 *   - return undefined to DROP (the feed never guesses).
 *
 * BE-7 implements it over the lineage store + resume ledger
 * (`native_session_id` indexes exist in both); composeBroker MUST inject it
 * at M4 so harness ids take over — consumers see no shape change either way.
 */
export type SessionIdResolver = (nativeSessionId: string) => string | undefined;
