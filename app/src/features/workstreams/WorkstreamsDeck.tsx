/**
 * The workstream lineage deck — FE-6's git-metaphor UX over the FROZEN
 * `workstream` channel (ws-protocol.md §16; blueprint §5; plan §5/FE-6 M4
 * slice). Left-zone instrument stack:
 *
 *   1. branch-now advisory strip — a DISMISSIBLE instrument state (context
 *      pressure is a reading, not a notification; never a toast);
 *   2. the workstream rail (list snapshot) + the detached-HEAD bucket;
 *   3. the lineage graph for the selected scope — rails on a fixed px gutter
 *      aligned to the --ig-grid-row rhythm, rows on the character grid;
 *      recorded vs inferred confidence renders in distinct registers (dimmed
 *      + dashed + an INF text marker — never color-only);
 *   4. the brief viewer (session-end / pre-compact / injection / merge);
 *   5. the merge flow — select N nodes, preview the conflict-surfacing brief,
 *      dispatch the frozen verb, watch the §16.4 correlation land.
 *
 * THE ONE CEREMONY (DESIGN.md §3.3) fires here and only here: when a
 * ledger-committed lineage edge lands (a `workstream-edge` EVENT — armed by
 * the store, coalesced to the newest per frame), the edge draws itself along
 * the rail (stroke-dashoffset, 480 ms) and the terminal node ring lights
 * amber then phosphor-decays to the channel hue. Reduced motion renders the
 * §3.5 discrete variant: settled edge, static amber ring for the 1200 ms
 * budget, reverted in one step. Nothing else in this deck is ceremonial.
 *
 * [X2]: every open-vocabulary wire string (titles, display names, git
 * branches, tags, brief bodies) is shape-masked before render; accounts
 * render only as the frozen placeholder labels.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  ACCOUNT_LABELS,
  LABEL_BACKENDS,
  type AccountLabel,
  type BranchAdvisory,
  type WorkstreamBriefPayload,
  type WorkstreamStatus,
} from '@aibender/protocol';
import { connectionStore } from '../../lib/index.ts';
import { usePrefersReducedMotion } from '../../chrome/phosphor.tsx';
import { maskIdentityShapedText } from '../launch/index.ts';
import './workstreams.css';
import {
  buildLineageLayout,
  edgesInOrder,
  nodesInScope,
  type LineageEdgeVM,
  type LineageRowVM,
} from './lineage.ts';
import { assembleMergePreview, dispatchMerge, type MergeDraft } from './merge.ts';
import type { Clock, WorkstreamMergeSender } from './ports.ts';
import {
  activeAdvisories,
  workstreamsStore,
  DETACHED_SCOPE,
  type CeremonyMarker,
  type MergeState,
} from './store.ts';

// ---------------------------------------------------------------------------
// Geometry + tokens
// ---------------------------------------------------------------------------

/** Rail gutter px space — ROW mirrors the --ig-grid-row token (20px). */
export const RAIL_ROW_PX = 20;
export const RAIL_LANE_PX = 12;

/** Ceremony wall-clock budget — mirrors --ig-latency-ceremony-budget. */
export const CEREMONY_BUDGET_MS = 1200;

/** Frozen account label → channel index-hue token (DESIGN.md §2.5). */
export const CHANNEL_HUE: Readonly<Record<AccountLabel, string>> = Object.freeze({
  MAX_A: 'var(--ig-channel-max-a)',
  MAX_B: 'var(--ig-channel-max-b)',
  ENT: 'var(--ig-channel-ent)',
  AWS_DEV: 'var(--ig-channel-bedrock)',
  LOCAL: 'var(--ig-channel-lmstudio)',
});

const STATUS_READOUT: Readonly<Record<WorkstreamStatus, string>> = Object.freeze({
  active: 'ACTIVE',
  paused: 'PAUSED',
  merged: 'MERGED',
  archived: 'ARCHIVED',
  abandoned: 'ABANDONED',
});

function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

let mergeIdCounter = 0;
function defaultNewMergeId(): string {
  mergeIdCounter += 1;
  return `mrg_fe_${mergeIdCounter}`;
}

export interface WorkstreamsDeckProps {
  /** Injectable clock (tests pin it; default Date.now). */
  readonly now?: Clock;
  /**
   * Outbound merge seam (ports.ts). Absent → the dispatch renders the
   * unsendable instrument state (the GatewayClient method is an ICR to FE-2).
   */
  readonly sender?: WorkstreamMergeSender;
  /** Injectable merge-correlation-id mint (tests pin it). */
  readonly newMergeId?: () => string;
}

// ---------------------------------------------------------------------------
// Ceremony orchestration (DESIGN.md §3.3 + the §3.5 discrete variant)
// ---------------------------------------------------------------------------

interface CeremonyView {
  /** Edge that draws itself (animated register only). */
  readonly edgeId: string | undefined;
  /** Node whose ring lights + decays (animated register only). */
  readonly nodeId: string | undefined;
  /** Retrigger key — a new lineage event remounts the animated elements. */
  readonly epoch: number;
  /** Reduced-motion: session id carrying the static amber ring. */
  readonly staticRingNodeId: string | undefined;
}

export function useCeremony(ceremony: CeremonyMarker | undefined): CeremonyView {
  const reduced = usePrefersReducedMotion();
  const [staticEpoch, setStaticEpoch] = useState(0);

  useEffect(() => {
    if (!reduced || ceremony === undefined) return undefined;
    // Discrete variant: static amber ring for the budget, then one-step revert.
    setStaticEpoch(ceremony.epoch);
    const handle = setTimeout(() => setStaticEpoch(0), CEREMONY_BUDGET_MS);
    return () => clearTimeout(handle);
  }, [reduced, ceremony]);

  if (ceremony === undefined) {
    return { edgeId: undefined, nodeId: undefined, epoch: 0, staticRingNodeId: undefined };
  }
  if (reduced) {
    return {
      edgeId: undefined,
      nodeId: undefined,
      epoch: ceremony.epoch,
      staticRingNodeId: staticEpoch === ceremony.epoch ? ceremony.toSessionId : undefined,
    };
  }
  return {
    edgeId: ceremony.edgeId,
    nodeId: ceremony.toSessionId,
    epoch: ceremony.epoch,
    staticRingNodeId: undefined,
  };
}

// ---------------------------------------------------------------------------
// Lineage graph (rails + rows)
// ---------------------------------------------------------------------------

function railPath(edge: LineageEdgeVM): string {
  const fx = edge.fromLane * RAIL_LANE_PX + RAIL_LANE_PX / 2;
  const fy = edge.fromRow * RAIL_ROW_PX + RAIL_ROW_PX / 2;
  const tx = edge.toLane * RAIL_LANE_PX + RAIL_LANE_PX / 2;
  const ty = edge.toRow * RAIL_ROW_PX + RAIL_ROW_PX / 2;
  if (fx === tx) return `M ${fx} ${fy} L ${tx} ${ty}`;
  const elbowY = ty - RAIL_ROW_PX / 2;
  return `M ${fx} ${fy} L ${fx} ${elbowY} L ${tx} ${elbowY} L ${tx} ${ty}`;
}

interface LineageGraphProps {
  readonly rows: readonly LineageRowVM[];
  readonly edges: readonly LineageEdgeVM[];
  readonly ceremony: CeremonyView;
  readonly selection: ReadonlySet<string>;
  readonly onRowClick: (sessionId: string) => void;
}

function LineageGraph({
  rows,
  edges,
  ceremony,
  selection,
  onRowClick,
}: LineageGraphProps): ReactNode {
  if (rows.length === 0) {
    return (
      <div className="ig-inbox-empty ig-engraved" data-testid="ws-graph-empty">
        NO NODES IN SCOPE
      </div>
    );
  }
  const maxLane = rows.reduce((max, row) => Math.max(max, row.lane), 0);
  const width = (maxLane + 1) * RAIL_LANE_PX;
  const height = rows.length * RAIL_ROW_PX;

  return (
    <div className="ig-ws-graph" data-testid="ws-graph">
      <svg
        className="ig-ws-rails"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        {edges
          .filter((e) => !(e.fromRow === e.toRow && e.fromLane === e.toLane))
          .map((edge) => {
            const ceremonial = edge.edgeId === ceremony.edgeId;
            return (
              <path
                key={ceremonial ? `${edge.edgeId}:${ceremony.epoch}` : edge.edgeId}
                d={railPath(edge)}
                pathLength={1}
                className={ceremonial ? 'ig-ws-ceremony-edge' : undefined}
                data-testid={`ws-edge-${edge.edgeId}`}
                data-edge-type={edge.edgeType}
                data-confidence={edge.confidence}
                data-ceremony={ceremonial ? 'true' : 'false'}
              />
            );
          })}
      </svg>
      <div className="ig-ws-rows">
        {rows.map((row) => {
          const ringCeremony = row.sessionId === ceremony.nodeId;
          const hue = CHANNEL_HUE[row.node.account];
          return (
            <div
              key={row.sessionId}
              className="ig-ws-row"
              style={{ '--ig-ws-hue': hue } as CSSProperties}
              data-testid={`ws-node-${row.sessionId}`}
              data-state={row.node.state}
              data-confidence={row.node.confidence}
              data-origin={row.node.origin}
              data-lane={row.lane}
              data-row={row.row}
              data-merge={row.isMerge ? 'true' : 'false'}
              data-selected={selection.has(row.sessionId) ? 'true' : 'false'}
              data-ceremony-static={
                row.sessionId === ceremony.staticRingNodeId ? 'true' : 'false'
              }
              role="button"
              tabIndex={0}
              onClick={() => onRowClick(row.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onRowClick(row.sessionId);
              }}
            >
              <span
                key={ringCeremony ? `ring:${ceremony.epoch}` : 'ring'}
                className={`ig-ws-node-ring${ringCeremony ? ' ig-ws-ceremony-ring' : ''}`}
              />
              <span className="ig-ws-id">{row.sessionId}</span>
              <span className="ig-engraved">{row.node.account}</span>
              <span className="ig-engraved">{row.node.state.toUpperCase()}</span>
              <span className="ig-engraved" data-testid={`ws-conf-${row.sessionId}`}>
                {row.node.confidence === 'recorded' ? 'REC' : 'INF'}
              </span>
              {row.isMerge ? (
                <span className="ig-engraved" data-testid={`ws-merge-badge-${row.sessionId}`}>
                  MERGE ×{row.parentSessionIds.length}
                </span>
              ) : null}
              {row.hasSelfContinue ? <span className="ig-engraved">IN-PLACE</span> : null}
              {row.node.displayName !== undefined ? (
                <span className="ig-ws-id">{maskIdentityShapedText(row.node.displayName)}</span>
              ) : null}
              {row.node.gitBranch !== undefined ? (
                <span className="ig-engraved">{maskIdentityShapedText(row.node.gitBranch)}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advisory strip
// ---------------------------------------------------------------------------

interface AdvisoryStripProps {
  readonly advisories: readonly BranchAdvisory[];
  readonly onDismiss: (sessionId: string) => void;
}

function AdvisoryStrip({ advisories, onDismiss }: AdvisoryStripProps): ReactNode {
  if (advisories.length === 0) return null;
  return (
    <div data-testid="ws-advisories">
      {advisories.map((advisory) => (
        <div
          key={advisory.sessionId}
          className="ig-ws-advisory"
          data-status="degraded"
          data-testid={`ws-advisory-${advisory.sessionId}`}
        >
          <span className="ig-engraved ig-status-degraded">BRANCH NOW</span>
          <span className="ig-ws-id">{advisory.sessionId}</span>
          <span className="ig-engraved">{fmtPct(advisory.contextUsedPct)} CTX</span>
          <button
            type="button"
            className="ig-btn"
            data-testid={`ws-advisory-dismiss-${advisory.sessionId}`}
            onClick={() => onDismiss(advisory.sessionId)}
          >
            DISMISS
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brief viewer
// ---------------------------------------------------------------------------

const BRIEF_KIND_READOUT: Readonly<Record<WorkstreamBriefPayload['briefKind'], string>> =
  Object.freeze({
    'session-end': 'SESSION-END',
    'pre-compact': 'PRE-COMPACT',
    'session-start-injection': 'START-INJECTION',
    merge: 'MERGE',
  });

interface BriefViewerProps {
  readonly focusedSessionId: string | undefined;
  readonly briefs: Readonly<Record<string, WorkstreamBriefPayload>>;
  readonly briefOrder: readonly string[];
}

function BriefViewer({ focusedSessionId, briefs, briefOrder }: BriefViewerProps): ReactNode {
  const matches: WorkstreamBriefPayload[] = [];
  if (focusedSessionId !== undefined) {
    for (let i = briefOrder.length - 1; i >= 0; i -= 1) {
      const id = briefOrder[i];
      const brief = id === undefined ? undefined : briefs[id];
      if (brief !== undefined && brief.sourceSessionIds.includes(focusedSessionId)) {
        matches.push(brief);
      }
    }
  }
  const latest = matches[0];
  return (
    <section
      className="ig-panel"
      data-testid="ws-brief-view"
      data-status={latest === undefined ? 'nosignal' : 'ok'}
    >
      <header className="ig-panel-header">
        <span className="ig-engraved">BRIEF</span>
        <span className="ig-panel-readout ig-engraved" data-testid="ws-brief-readout">
          {latest === undefined
            ? focusedSessionId === undefined
              ? 'NO NODE'
              : 'NO BRIEF'
            : `${BRIEF_KIND_READOUT[latest.briefKind]} · ${latest.provenance.toUpperCase()}`}
        </span>
      </header>
      <div className="ig-panel-body">
        {latest !== undefined ? (
          <>
            <pre className="ig-ws-brief-body" data-testid="ws-brief-body">
              {maskIdentityShapedText(latest.body)}
            </pre>
            {matches.length > 1 ? (
              <div className="ig-engraved" data-testid="ws-brief-more">
                +{matches.length - 1} EARLIER
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Merge panel
// ---------------------------------------------------------------------------

function mergeStatus(state: MergeState | undefined): 'ok' | 'degraded' | 'fault' | 'nosignal' {
  switch (state?.phase) {
    case 'resolved':
      return 'ok';
    case 'pending':
      return 'degraded';
    case 'failed':
    case 'blocked':
      return 'fault';
    case 'unsendable':
      return 'nosignal';
    default:
      return 'ok';
  }
}

function mergeReadout(state: MergeState | undefined, selectionCount: number): string {
  switch (state?.phase) {
    case 'resolved':
      return `RESOLVED → ${state.sessionId ?? ''}`;
    case 'pending':
      return 'PENDING';
    case 'failed':
      return `FAILED · ${state.code ?? 'internal'}`;
    case 'blocked':
      return `BLOCKED · ${state.code ?? 'bad-request'}`;
    case 'unsendable':
      return 'NOT CONNECTED';
    default:
      return `${selectionCount} SELECTED`;
  }
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

export function WorkstreamsDeck({ now, sender, newMergeId }: WorkstreamsDeckProps): ReactNode {
  void (now ?? Date.now); // clock reserved for staleness readouts (M5 lenses)
  const mintMergeId = newMergeId ?? defaultNewMergeId;

  const phase = useStore(connectionStore, (s) => s.phase);
  const rail = useStore(workstreamsStore, (s) => s.rail);
  const nodes = useStore(workstreamsStore, (s) => s.nodes);
  const edges = useStore(workstreamsStore, (s) => s.edges);
  const edgeOrder = useStore(workstreamsStore, (s) => s.edgeOrder);
  const briefs = useStore(workstreamsStore, (s) => s.briefs);
  const briefOrder = useStore(workstreamsStore, (s) => s.briefOrder);
  const advisories = useStore(workstreamsStore, (s) => s.advisories);
  const advisoryDismissedAt = useStore(workstreamsStore, (s) => s.advisoryDismissedAt);
  const merges = useStore(workstreamsStore, (s) => s.merges);
  const ceremonyMarker = useStore(workstreamsStore, (s) => s.ceremony);

  const [scopeChoice, setScopeChoice] = useState<string | undefined>(undefined);
  const [selectionOrder, setSelectionOrder] = useState<readonly string[]>([]);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const [account, setAccount] = useState<AccountLabel>('MAX_A');
  const [cwd, setCwd] = useState('');
  const [cwdTouched, setCwdTouched] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [briefBody, setBriefBody] = useState('');
  const [lastMergeId, setLastMergeId] = useState<string | undefined>(undefined);

  const ceremony = useCeremony(ceremonyMarker);

  const scope =
    scopeChoice ?? rail?.workstreams[0]?.workstreamId ?? DETACHED_SCOPE;
  const selection = useMemo(() => new Set(selectionOrder), [selectionOrder]);

  const layout = useMemo(() => {
    const scoped = nodesInScope(nodes, scope);
    return buildLineageLayout(scoped, edgesInOrder(edges, edgeOrder));
  }, [nodes, edges, edgeOrder, scope]);

  const visibleAdvisories = useMemo(
    () => activeAdvisories({ advisories, advisoryDismissedAt }),
    [advisories, advisoryDismissedAt],
  );

  if (phase !== 'connected') {
    // A down gateway dims the whole deck — NO SIGNAL, slots retained.
    return (
      <div className="ig-ws-deck" id="ig-workstreams" data-testid="workstreams-deck">
        {(['WORKSTREAMS', 'LINEAGE', 'BRIEF'] as const).map((label) => (
          <section key={label} className="ig-panel" data-status="nosignal">
            <header className="ig-panel-header">
              <span className="ig-engraved">{label}</span>
              <span className="ig-panel-readout ig-status-nosignal" data-testid="ws-nosignal">
                NO SIGNAL
              </span>
            </header>
            <div className="ig-panel-detail">
              {phase === 'auth-rejected' ? 'GATEWAY AUTH FAULT' : 'NO GATEWAY'}
            </div>
          </section>
        ))}
      </div>
    );
  }

  const onRowClick = (sessionId: string): void => {
    setFocused(sessionId);
    setSelectionOrder((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId],
    );
  };

  const firstSelectedNode = selectionOrder
    .map((id) => nodes[id])
    .find((node) => node !== undefined);
  const effectiveCwd = cwdTouched ? cwd : (firstSelectedNode?.cwd ?? '');
  const mergeState = lastMergeId === undefined ? undefined : merges[lastMergeId];
  const preview = assembleMergePreview(selectionOrder, briefs, briefOrder);

  const onDispatch = (): void => {
    const mergeId = mintMergeId();
    const draft: MergeDraft = {
      parents: selectionOrder,
      accountLabel: account,
      backend: LABEL_BACKENDS[account],
      cwd: effectiveCwd,
      purpose,
      briefBody,
      ...(scope !== DETACHED_SCOPE ? { workstreamId: scope } : {}),
    };
    dispatchMerge(draft, mergeId, { store: workstreamsStore, sender });
    setLastMergeId(mergeId);
  };

  return (
    <div className="ig-ws-deck" id="ig-workstreams" data-testid="workstreams-deck">
      <AdvisoryStrip
        advisories={visibleAdvisories}
        onDismiss={(sessionId) => workstreamsStore.getState().dismissAdvisory(sessionId)}
      />

      {/* 1 · the rail */}
      <section className="ig-panel" data-testid="ws-rail">
        <header className="ig-panel-header">
          <span className="ig-engraved">WORKSTREAMS</span>
          <span className="ig-panel-readout ig-engraved" data-testid="ws-rail-readout">
            {rail === undefined
              ? 'NO SNAPSHOT'
              : `${rail.workstreams.length} WS · ${rail.detachedNodeCount} DET`}
          </span>
        </header>
        <div className="ig-panel-body">
          {(rail?.workstreams ?? []).map((summary) => (
            <div
              key={summary.workstreamId}
              className="ig-ws-rail-row"
              data-testid={`ws-rail-${summary.workstreamId}`}
              data-selected={scope === summary.workstreamId ? 'true' : 'false'}
              role="button"
              tabIndex={0}
              onClick={() => setScopeChoice(summary.workstreamId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setScopeChoice(summary.workstreamId);
              }}
            >
              <span className="ig-ws-rail-title">{maskIdentityShapedText(summary.title)}</span>
              <span className="ig-engraved">{STATUS_READOUT[summary.status]}</span>
              <span className="ig-engraved">{summary.nodeCount}</span>
            </div>
          ))}
          <div
            className="ig-ws-rail-row"
            data-testid="ws-rail-detached"
            data-selected={scope === DETACHED_SCOPE ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            onClick={() => setScopeChoice(DETACHED_SCOPE)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setScopeChoice(DETACHED_SCOPE);
            }}
          >
            <span className="ig-ws-rail-title ig-engraved">DETACHED HEAD</span>
            <span className="ig-engraved ig-status-nosignal">
              {rail === undefined ? '—' : rail.detachedNodeCount}
            </span>
          </div>
        </div>
      </section>

      {/* 2 · the lineage graph */}
      <section className="ig-panel" data-testid="ws-lineage" data-scope={scope}>
        <header className="ig-panel-header">
          <span className="ig-engraved">LINEAGE</span>
          <span className="ig-panel-readout ig-engraved" data-testid="ws-lineage-readout">
            {scope === DETACHED_SCOPE ? 'DETACHED HEAD' : scope}
          </span>
        </header>
        <div className="ig-panel-body">
          <LineageGraph
            rows={layout.rows}
            edges={layout.edges}
            ceremony={ceremony}
            selection={selection}
            onRowClick={onRowClick}
          />
        </div>
      </section>

      {/* 3 · the brief viewer */}
      <BriefViewer focusedSessionId={focused} briefs={briefs} briefOrder={briefOrder} />

      {/* 4 · the merge flow */}
      <section
        className="ig-panel"
        data-testid="ws-merge-panel"
        data-status={mergeStatus(mergeState)}
      >
        <header className="ig-panel-header">
          <span className="ig-engraved">MERGE</span>
          <span className="ig-panel-readout ig-engraved" data-testid="ws-merge-state">
            {mergeReadout(mergeState, selectionOrder.length)}
          </span>
        </header>
        <div className="ig-panel-body">
          {preview.parents.map((parent) => (
            <div
              key={parent.sessionId}
              className="ig-ws-merge-row"
              data-testid={`ws-merge-parent-${parent.sessionId}`}
            >
              <span className="ig-ws-id">{parent.sessionId}</span>
              <span className="ig-engraved">
                {parent.excerpt ?? 'NO BRIEF RECORDED'}
              </span>
            </div>
          ))}
          <div className="ig-ws-merge-row">
            <span className="ig-engraved">RUN ON</span>
            <select
              className="ig-ws-input"
              data-testid="ws-merge-account"
              value={account}
              onChange={(e) => setAccount(e.target.value as AccountLabel)}
            >
              {ACCOUNT_LABELS.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
            <span className="ig-engraved">{LABEL_BACKENDS[account].toUpperCase()}</span>
          </div>
          <div className="ig-ws-merge-row">
            <span className="ig-engraved">CWD</span>
            <input
              className="ig-ws-input ig-ws-merge-field"
              data-testid="ws-merge-cwd"
              value={effectiveCwd}
              onChange={(e) => {
                setCwdTouched(true);
                setCwd(e.target.value);
              }}
            />
          </div>
          <div className="ig-ws-merge-row">
            <span className="ig-engraved">PURPOSE</span>
            <input
              className="ig-ws-input ig-ws-merge-field"
              data-testid="ws-merge-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>
          <textarea
            className="ig-ws-input ig-ws-brief-editor"
            data-testid="ws-merge-brief"
            aria-label="conflict-surfacing merge brief"
            value={briefBody}
            onChange={(e) => setBriefBody(e.target.value)}
          />
          <div className="ig-ws-merge-row">
            <button
              type="button"
              className="ig-btn"
              data-testid="ws-merge-seed"
              onClick={() => setBriefBody(preview.seededBody)}
            >
              {preview.draft !== undefined ? 'LOAD DRAFT BRIEF' : 'SEED BRIEF SCAFFOLD'}
            </button>
            <button
              type="button"
              className="ig-btn"
              data-testid="ws-merge-dispatch"
              disabled={selectionOrder.length === 0}
              onClick={onDispatch}
            >
              MERGE {selectionOrder.length} NODES
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
