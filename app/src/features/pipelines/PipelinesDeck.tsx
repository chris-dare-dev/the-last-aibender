/**
 * The pipelines deck — FE-6's builder + run monitor over the FROZEN
 * `pipelines` channel (ws-protocol.md §18; the DAG document is dag-schema.md
 * v1; blueprint §7; plan §5/FE-6 M5 slice). Two surfaces, one deck:
 *
 *   BUILDER
 *     1. the PALETTE — kind-grouped catalog rows (catalog.ts); degraded /
 *        unusable rows render as instrument states, NEVER hidden;
 *     2. the CANVAS — a DAG of steps + `needs` edges; each step wears its
 *        account label PROMINENTLY (the [X1] differentiator, visually
 *        first-class — the five frozen labels only, [X2]); the `approval`
 *        gate is a first-class node kind; when/forEach/loop are per-node
 *        affordances;
 *     3. VALIDATE / SAVE — the frozen verbs; the frozen dag/ issue class
 *        renders as an instrument state (never a toast).
 *
 *   RUN MONITOR
 *     1. the run list (left-zone fleet) with per-run status + Σ cost EST;
 *     2. per-step status + cost from the events-store-fed payloads; a
 *        `memoized` step reads MEMOIZED (settled — NO re-animation; pipelines
 *        carry NO ceremony, DESIGN.md §3.3);
 *     3. an `awaiting-approval` gate DEEP-LINKS into THE single approval inbox
 *        (M2 — we do not build a second inbox);
 *     4. launch / pause / resume / cancel round-trips; `resumable` drives the
 *        resume-from-journal affordance (the M5 DoD).
 *
 * [X2]: every open-vocabulary wire string (names, prompts, paths shown as
 * text) is shape-masked before render; accounts render only as the frozen
 * placeholder labels via the channel-hue map.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  backendForLabel,
  type AccountLabel,
  type CatalogEntry,
  type PipelineRunStatusRecord,
  type StepKind,
} from '@aibender/protocol';
import {
  channelHueForLabel,
  connectionStore,
  approvalsStore,
  useAccountRegistry,
  type PendingApproval,
} from '../../lib/index.ts';
import { maskIdentityShapedText } from '../launch/index.ts';
import './pipelines.css';
import {
  buildPalette,
  paletteHealth,
  type CatalogGroup,
  type CatalogRow,
} from './catalog.ts';
import {
  addNode,
  emptyBuilderDoc,
  isExecutableKind,
  removeNode,
  updateNode,
  validateBuilderDoc,
  type BuilderDoc,
  type BuilderNode,
} from './dagModel.ts';
import {
  catalogEntriesFor,
  pipelinesStore,
  runsInOrder,
  stepsForRun,
  type VerbState,
} from './store.ts';
import {
  buildCancelRequest,
  buildLaunchRequest,
  buildPauseRequest,
  buildResumeRequest,
  buildSaveRequest,
  buildValidateRequest,
  dispatchVerb,
} from './verbs.ts';
import {
  RUN_STATE_READOUT,
  STEP_STATE_READOUT,
  gateApprovalFor,
  runAccountsUsed,
  runControlsFor,
  runCostEstimate,
  runStatusRegister,
  stepStatusRegister,
  type InstrumentStatus,
} from './runMonitor.ts';
import type { Clock, PipelineVerbSender, RequestIdSource } from './ports.ts';

// ---------------------------------------------------------------------------
// Tokens + helpers
// ---------------------------------------------------------------------------

/**
 * Seed account label → channel index-hue token (DESIGN.md §2.5) — identity
 * tick only, never a fill. Back-compat constant for the seed five; the
 * per-step chip derives its hue from the registry via `channelHueForLabel`
 * ([X1]) so a MAX_<X> account routes+ticks with no new token.
 */
export const CHANNEL_HUE: Readonly<Record<AccountLabel, string>> = Object.freeze({
  MAX_A: 'var(--ig-channel-max-a)',
  MAX_B: 'var(--ig-channel-max-b)',
  ENT: 'var(--ig-channel-ent)',
  AWS_DEV: 'var(--ig-channel-bedrock)',
  LOCAL: 'var(--ig-channel-lmstudio)',
});

const KIND_READOUT: Readonly<Record<StepKind, string>> = Object.freeze({
  prompt: 'PROMPT',
  skill: 'SKILL',
  agent: 'AGENT',
  'workflow-script': 'SCRIPT',
  approval: 'GATE',
});

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `req_fe_${requestCounter}`;
}

let nodeCounter = 0;
function defaultNodeId(kind: StepKind): string {
  nodeCounter += 1;
  return `${kind === 'workflow-script' ? 'script' : kind}_${nodeCounter}`;
}

export interface PipelinesDeckProps {
  /** Injectable clock (tests pin it; default Date.now). Reserved for staleness. */
  readonly now?: Clock;
  /**
   * Outbound verb seam (ports.ts). Absent → every dispatch renders the
   * unsendable instrument state (the GatewayClient method is an ICR to FE-2).
   */
  readonly sender?: PipelineVerbSender;
  /** Injectable request-id mint (tests pin it). */
  readonly newRequestId?: RequestIdSource;
  /** Injectable node-id mint (tests pin it). */
  readonly newNodeId?: (kind: StepKind) => string;
}

// ---------------------------------------------------------------------------
// The account-routing chip — the [X1] differentiator, visually first-class
// ---------------------------------------------------------------------------

interface AccountChipProps {
  /** The routed account, or undefined = inherits the document default. */
  readonly account: AccountLabel | undefined;
  readonly onChange?: (account: AccountLabel) => void;
  readonly testId: string;
}

/**
 * Every executable step wears this chip PROMINENTLY: the frozen placeholder
 * label + a channel index-hue tick (identity tick — hairline scale, never a
 * fill, DESIGN.md §2.5). This is the whole [X1] point — per-step routing is
 * glanceable, and the chooser lists the CONFIGURED registry (N accounts + the
 * two backends), not a hardcoded five. Only sanctioned placeholder labels can
 * ever render here ([X2]).
 */
function AccountChip({ account, onChange, testId }: AccountChipProps): ReactNode {
  const label = account ?? 'MAX_A';
  const hue = channelHueForLabel(label);
  // FE-1: reactive registry — a broker-restart re-sync re-renders the routing
  // options so a newly-provisioned account appears without a reload.
  const registry = useAccountRegistry();
  if (onChange === undefined) {
    return (
      <span
        className="ig-pl-account"
        style={{ '--ig-pl-hue': hue } as CSSProperties}
        data-testid={testId}
        data-account={account ?? 'default'}
      >
        <span className="ig-pl-account-tick" aria-hidden="true" />
        <span className="ig-engraved">{account ?? 'DEFAULT'}</span>
      </span>
    );
  }
  return (
    <span
      className="ig-pl-account"
      style={{ '--ig-pl-hue': hue } as CSSProperties}
      data-testid={testId}
      data-account={account ?? 'default'}
    >
      <span className="ig-pl-account-tick" aria-hidden="true" />
      <select
        className="ig-pl-account-select ig-engraved"
        aria-label="step account routing"
        value={label}
        onChange={(e) => onChange(e.target.value as AccountLabel)}
      >
        {registry.entries.map((entry) => (
          <option key={entry.label} value={entry.label}>
            {entry.label}
          </option>
        ))}
      </select>
      <span className="ig-engraved">{backendForLabel(label).toUpperCase()}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

interface PaletteProps {
  readonly groups: readonly CatalogGroup[];
  readonly onDrop: (row: CatalogRow) => void;
}

function PaletteRow({ row, onDrop }: { row: CatalogRow; onDrop: (r: CatalogRow) => void }): ReactNode {
  const entry = row.entry;
  const status: InstrumentStatus =
    row.status === 'ok' ? 'ok' : row.status === 'degraded' ? 'degraded' : 'nosignal';
  return (
    <div
      className="ig-pl-palette-row"
      data-testid={`pl-cap-${entry.capId}`}
      data-status={status}
      data-selectable={row.selectable ? 'true' : 'false'}
    >
      <span className="ig-pl-cap-name">{maskIdentityShapedText(entry.name)}</span>
      <span className="ig-engraved">{entry.scope.toUpperCase()}</span>
      {row.flags.map((flag) => (
        <span
          key={flag}
          className="ig-engraved ig-pl-flag"
          data-testid={`pl-cap-flag-${entry.capId}-${flag}`}
        >
          {flag === 'relative-source'
            ? 'REL-PATH'
            : flag === 'unhashed'
              ? 'UNHASHED'
              : 'NO-MODEL-INVOKE'}
        </span>
      ))}
      <button
        type="button"
        className="ig-btn"
        data-testid={`pl-cap-add-${entry.capId}`}
        disabled={!row.selectable}
        onClick={() => onDrop(row)}
      >
        ADD
      </button>
    </div>
  );
}

function Palette({ groups, onDrop }: PaletteProps): ReactNode {
  const health = paletteHealth(groups);
  return (
    <section className="ig-panel" data-testid="pl-palette" data-status={health.total === 0 ? 'nosignal' : 'ok'}>
      <header className="ig-panel-header">
        <span className="ig-engraved">PALETTE</span>
        <span className="ig-panel-readout ig-engraved" data-testid="pl-palette-readout">
          {health.total === 0
            ? 'NO CATALOG'
            : `${health.total} CAP · ${health.degraded} DEG · ${health.unusable} UNUSABLE`}
        </span>
      </header>
      <div className="ig-panel-body">
        {groups.map((group) => (
          <div key={group.kind} data-testid={`pl-group-${group.kind}`}>
            <div className="ig-engraved ig-pl-group-head">{group.kind.toUpperCase()}</div>
            {group.rows.length === 0 ? (
              <div className="ig-engraved ig-status-nosignal" data-testid={`pl-group-empty-${group.kind}`}>
                —
              </div>
            ) : (
              group.rows.map((row) => (
                <PaletteRow key={row.entry.capId} row={row} onDrop={onDrop} />
              ))
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The canvas (steps + needs edges + per-step routing + gate placement)
// ---------------------------------------------------------------------------

interface CanvasProps {
  readonly doc: BuilderDoc;
  readonly onAccount: (id: string, account: AccountLabel) => void;
  readonly onNeeds: (id: string, needs: readonly string[]) => void;
  readonly onRemove: (id: string) => void;
  readonly onAddGate: () => void;
}

function StepCard({
  node,
  allIds,
  onAccount,
  onNeeds,
  onRemove,
}: {
  node: BuilderNode;
  allIds: readonly string[];
  onAccount: (id: string, account: AccountLabel) => void;
  onNeeds: (id: string, needs: readonly string[]) => void;
  onRemove: (id: string) => void;
}): ReactNode {
  const gate = node.kind === 'approval';
  return (
    <div
      className="ig-pl-step"
      data-testid={`pl-step-${node.id}`}
      data-kind={node.kind}
      data-gate={gate ? 'true' : 'false'}
    >
      <div className="ig-pl-step-head">
        <span className="ig-pl-step-id">{node.id}</span>
        <span className="ig-engraved" data-testid={`pl-step-kind-${node.id}`}>
          {KIND_READOUT[node.kind]}
        </span>
        {isExecutableKind(node.kind) ? (
          <AccountChip
            account={node.account}
            onChange={(a) => onAccount(node.id, a)}
            testId={`pl-step-account-${node.id}`}
          />
        ) : (
          <span className="ig-engraved ig-pl-gate-badge" data-testid={`pl-step-gate-${node.id}`}>
            HUMAN GATE
          </span>
        )}
        <button
          type="button"
          className="ig-btn"
          data-testid={`pl-step-remove-${node.id}`}
          onClick={() => onRemove(node.id)}
        >
          DEL
        </button>
      </div>
      <div className="ig-pl-step-needs">
        <span className="ig-engraved">NEEDS</span>
        <select
          className="ig-pl-input ig-engraved"
          aria-label={`needs edges for ${node.id}`}
          data-testid={`pl-step-needs-${node.id}`}
          multiple
          value={[...(node.needs ?? [])]}
          onChange={(e) => {
            const picked = [...e.target.selectedOptions].map((o) => o.value);
            onNeeds(node.id, picked);
          }}
        >
          {allIds
            .filter((id) => id !== node.id)
            .map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

function Canvas({ doc, onAccount, onNeeds, onRemove, onAddGate }: CanvasProps): ReactNode {
  const allIds = doc.nodes.map((n) => n.id);
  return (
    <section className="ig-panel" data-testid="pl-canvas">
      <header className="ig-panel-header">
        <span className="ig-engraved">CANVAS</span>
        <span className="ig-panel-readout ig-engraved" data-testid="pl-canvas-readout">
          {doc.nodes.length} STEP{doc.nodes.length === 1 ? '' : 'S'}
        </span>
        <button
          type="button"
          className="ig-btn"
          data-testid="pl-add-gate"
          onClick={onAddGate}
        >
          + GATE
        </button>
      </header>
      <div className="ig-panel-body">
        {doc.nodes.length === 0 ? (
          <div className="ig-engraved ig-status-nosignal" data-testid="pl-canvas-empty">
            EMPTY — ADD FROM PALETTE
          </div>
        ) : (
          doc.nodes.map((node) => (
            <StepCard
              key={node.id}
              node={node}
              allIds={allIds}
              onAccount={onAccount}
              onNeeds={onNeeds}
              onRemove={onRemove}
            />
          ))
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Validate/save instrument readout
// ---------------------------------------------------------------------------

function verbStatus(state: VerbState | undefined): InstrumentStatus {
  switch (state?.phase) {
    case 'answered':
      return state.valid === false ? 'fault' : 'ok';
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

function verbReadout(state: VerbState | undefined): string {
  switch (state?.phase) {
    case 'answered':
      if (state.pipelineId !== undefined) return `SAVED → ${state.pipelineId}`;
      if (state.valid === true) return 'VALID';
      return `INVALID · ${state.issueCode ?? 'bad-shape'}`;
    case 'pending':
      return 'PENDING';
    case 'failed':
      return `FAILED · ${state.code ?? 'internal'}`;
    case 'blocked':
      return `BLOCKED · ${state.code ?? 'bad-request'}`;
    case 'unsendable':
      return 'NOT CONNECTED';
    default:
      return 'IDLE';
  }
}

// ---------------------------------------------------------------------------
// Run monitor
// ---------------------------------------------------------------------------

interface RunMonitorProps {
  readonly run: PipelineRunStatusRecord | undefined;
  readonly sender: PipelineVerbSender | undefined;
  readonly mintRequestId: () => string;
}

function RunMonitor({ run, sender, mintRequestId }: RunMonitorProps): ReactNode {
  const stepsMap = useStore(pipelinesStore, (s) => s.steps);
  const stepOrder = useStore(pipelinesStore, (s) => s.stepOrder);
  const pendingMap = useStore(approvalsStore, (s) => s.pending);
  const pendingOrder = useStore(approvalsStore, (s) => s.order);
  const steps = useMemo(
    () => (run === undefined ? [] : stepsForRun({ steps: stepsMap, stepOrder }, run.runId)),
    [run, stepsMap, stepOrder],
  );
  // Pending approvals in arrival order (the pendingApprovals selector, inlined
  // over the two raw slices — avoids re-deriving a new array identity each
  // render, the getSnapshot-cache rule).
  const pending = useMemo(() => {
    const out: PendingApproval[] = [];
    for (const id of pendingOrder) {
      const entry = pendingMap[id];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }, [pendingMap, pendingOrder]);

  if (run === undefined) {
    return (
      <section className="ig-panel" data-testid="pl-monitor" data-status="nosignal">
        <header className="ig-panel-header">
          <span className="ig-engraved">RUN MONITOR</span>
          <span className="ig-panel-readout ig-status-nosignal" data-testid="pl-monitor-readout">
            NO RUN
          </span>
        </header>
        <div className="ig-panel-detail">SELECT OR LAUNCH A RUN</div>
      </section>
    );
  }

  const controls = runControlsFor(run);
  const cost = runCostEstimate(run, steps);
  const accountsUsed = runAccountsUsed(steps);
  const dispatch = (message: Parameters<typeof dispatchVerb>[0]): void => {
    dispatchVerb(message, { store: pipelinesStore, sender });
  };

  return (
    <section
      className="ig-panel"
      data-testid="pl-monitor"
      data-status={runStatusRegister(run.state)}
      data-run={run.runId}
    >
      <header className="ig-panel-header">
        <span className="ig-engraved">RUN MONITOR</span>
        <span className="ig-panel-readout ig-engraved" data-testid="pl-monitor-readout">
          {RUN_STATE_READOUT[run.state]} · {fmtUsd(cost)} EST
        </span>
      </header>
      <div className="ig-panel-body">
        {/* run-level [X1] routing summary */}
        <div className="ig-pl-run-accounts" data-testid="pl-run-accounts">
          <span className="ig-engraved">ROUTED</span>
          {accountsUsed.length === 0 ? (
            <span className="ig-engraved ig-status-nosignal">—</span>
          ) : (
            accountsUsed.map((label) => (
              <AccountChip
                key={label}
                account={label as AccountLabel}
                testId={`pl-run-account-${label}`}
              />
            ))
          )}
        </div>

        {/* per-step status + cost */}
        {steps.map((step) => {
          const gateApproval = gateApprovalFor(step.runId, step.stepId, pending);
          return (
            <div
              key={`${step.stepId}:${step.iteration}:${step.attempt}`}
              className="ig-pl-run-step"
              data-testid={`pl-run-step-${step.stepId}-${step.iteration}-${step.attempt}`}
              data-state={step.state}
              data-status={stepStatusRegister(step.state)}
            >
              <span className="ig-pl-step-id">{step.stepId}</span>
              {step.iteration > 0 ? (
                <span className="ig-engraved" data-testid={`pl-run-iter-${step.stepId}`}>
                  #{step.iteration}
                </span>
              ) : null}
              {step.attempt > 0 ? (
                <span className="ig-engraved" data-testid={`pl-run-attempt-${step.stepId}`}>
                  ×{step.attempt + 1}
                </span>
              ) : null}
              <span className="ig-engraved" data-testid={`pl-run-state-${step.stepId}`}>
                {STEP_STATE_READOUT[step.state]}
              </span>
              {step.account !== undefined ? (
                <AccountChip account={step.account} testId={`pl-run-step-account-${step.stepId}`} />
              ) : null}
              <span className="ig-engraved" data-testid={`pl-run-cost-${step.stepId}`}>
                {step.costEstimatedUsd === undefined ? '—' : `${fmtUsd(step.costEstimatedUsd)} EST`}
              </span>
              {step.state === 'failed' && step.errorKind !== undefined ? (
                <span className="ig-engraved ig-status-fault" data-testid={`pl-run-error-${step.stepId}`}>
                  {maskIdentityShapedText(step.errorKind)}
                </span>
              ) : null}
              {step.state === 'awaiting-approval' ? (
                <button
                  type="button"
                  className="ig-btn"
                  data-testid={`pl-run-gate-${step.stepId}`}
                  data-approval={gateApproval ?? ''}
                  onClick={() => {
                    document.getElementById('ig-approvals')?.scrollIntoView();
                  }}
                >
                  {gateApproval === undefined ? 'AWAITING GATE' : 'DECIDE IN INBOX'}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* control round-trips */}
      <div className="ig-pl-run-controls">
        <button
          type="button"
          className="ig-btn"
          data-testid="pl-run-pause"
          disabled={!controls.pausable}
          onClick={() => dispatch(buildPauseRequest(mintRequestId(), run.runId))}
        >
          PAUSE
        </button>
        <button
          type="button"
          className="ig-btn"
          data-testid="pl-run-resume"
          disabled={!controls.resumable}
          data-resumable={controls.resumable ? 'true' : 'false'}
          onClick={() => dispatch(buildResumeRequest(mintRequestId(), run.runId))}
        >
          RESUME
        </button>
        <button
          type="button"
          className="ig-btn"
          data-testid="pl-run-cancel"
          disabled={!controls.cancellable}
          onClick={() => dispatch(buildCancelRequest(mintRequestId(), run.runId))}
        >
          CANCEL
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

type DeckMode = 'builder' | 'monitor';

export function PipelinesDeck({
  now,
  sender,
  newRequestId,
  newNodeId,
}: PipelinesDeckProps): ReactNode {
  void (now ?? Date.now); // clock reserved for staleness readouts (M6 lenses)
  const mintRequestId = newRequestId ?? defaultRequestId;
  const mintNodeId = newNodeId ?? defaultNodeId;

  const phase = useStore(connectionStore, (s) => s.phase);
  const catalog = useStore(pipelinesStore, (s) => s.catalog);
  const runsMap = useStore(pipelinesStore, (s) => s.runs);
  const runOrder = useStore(pipelinesStore, (s) => s.runOrder);
  const verbs = useStore(pipelinesStore, (s) => s.verbs);
  const runs = useMemo(() => runsInOrder({ runs: runsMap, runOrder }), [runsMap, runOrder]);

  const [mode, setMode] = useState<DeckMode>('builder');
  const [workspace, setWorkspace] = useState<string | undefined>(undefined);
  const [doc, setDoc] = useState<BuilderDoc>(() => emptyBuilderDoc('wf_draft', 'draft pipeline'));
  const [lastRequestId, setLastRequestId] = useState<string | undefined>(undefined);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);

  // Default the selected run to the newest once runs arrive.
  useEffect(() => {
    if (selectedRunId === undefined && runs.length > 0) {
      setSelectedRunId(runs[runs.length - 1]?.runId);
    }
  }, [runs, selectedRunId]);

  const entries = useMemo(
    () => catalogEntriesFor({ catalog }, workspace),
    [catalog, workspace],
  );
  const palette = useMemo(() => buildPalette(entries), [entries]);
  const selectedRun = runs.find((r) => r.runId === selectedRunId);
  const verbState = lastRequestId === undefined ? undefined : verbs[lastRequestId];

  if (phase !== 'connected') {
    return (
      <div className="ig-pl-deck" id="ig-pipelines" data-testid="pipelines-deck">
        {(['PALETTE', 'CANVAS', 'RUN MONITOR'] as const).map((label) => (
          <section key={label} className="ig-panel" data-status="nosignal">
            <header className="ig-panel-header">
              <span className="ig-engraved">{label}</span>
              <span className="ig-panel-readout ig-status-nosignal" data-testid="pl-nosignal">
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

  const dropCapability = (row: CatalogRow): void => {
    const entry: CatalogEntry = row.entry;
    const kind: StepKind = entry.kind === 'agent' || entry.kind === 'oc-agent' ? 'agent' : 'skill';
    const id = mintNodeId(kind);
    const account = entry.accounts?.length === 1 ? entry.accounts[0] : undefined;
    const node: BuilderNode =
      kind === 'agent'
        ? {
            id,
            kind: 'agent',
            agent: { name: entry.name, scope: entry.scope },
            prompt: `run ${entry.name}`,
            ...(account !== undefined ? { account } : {}),
          }
        : {
            id,
            kind: 'skill',
            skill: { name: entry.name, scope: entry.scope },
            ...(account !== undefined ? { account } : {}),
          };
    setDoc((d) => addNode(d, node));
  };

  const addGate = (): void => {
    const id = mintNodeId('approval');
    setDoc((d) => addNode(d, { id, kind: 'approval', summary: 'review before continuing' }));
  };

  const onAccount = (id: string, account: AccountLabel): void => {
    setDoc((d) => updateNode(d, id, { account }));
  };
  const onNeeds = (id: string, needs: readonly string[]): void => {
    setDoc((d) => updateNode(d, id, { needs }));
  };
  const onRemove = (id: string): void => {
    setDoc((d) => removeNode(d, id));
  };

  const dispatch = (message: Parameters<typeof dispatchVerb>[0]): void => {
    dispatchVerb(message, { store: pipelinesStore, sender });
    setLastRequestId(message.requestId);
  };

  const onValidate = (): void => {
    const verdict = validateBuilderDoc(doc);
    const requestId = mintRequestId();
    if (!verdict.ok) {
      // A locally-invalid document: track the frozen issue class directly (the
      // server never sees it — the FE is the first authority, the broker the
      // final one). Mirrors the validation-result the broker would answer.
      pipelinesStore.getState().trackVerb({
        requestId,
        verb: 'pipeline-validate',
        phase: 'answered',
        valid: false,
        issueCode: verdict.issue.code,
        issueMessage: verdict.issue.message,
        issuePath: verdict.issue.path,
      });
      setLastRequestId(requestId);
      return;
    }
    dispatch(buildValidateRequest(requestId, verdict.document));
  };

  const onSave = (): void => {
    const verdict = validateBuilderDoc(doc);
    const requestId = mintRequestId();
    if (!verdict.ok) {
      pipelinesStore.getState().trackVerb({
        requestId,
        verb: 'pipeline-save',
        phase: 'blocked',
        code: 'bad-request',
        valid: false,
        issueCode: verdict.issue.code,
        issueMessage: verdict.issue.message,
        issuePath: verdict.issue.path,
      });
      setLastRequestId(requestId);
      return;
    }
    dispatch(buildSaveRequest(requestId, verdict.document));
  };

  const onLaunch = (): void => {
    const verdict = validateBuilderDoc(doc);
    const requestId = mintRequestId();
    if (!verdict.ok) {
      pipelinesStore.getState().trackVerb({
        requestId,
        verb: 'pipeline-launch',
        phase: 'blocked',
        code: 'bad-request',
        valid: false,
        issueCode: verdict.issue.code,
        issueMessage: verdict.issue.message,
        issuePath: verdict.issue.path,
      });
      setLastRequestId(requestId);
      return;
    }
    dispatch(buildLaunchRequest(requestId, { document: verdict.document }));
    setMode('monitor');
  };

  return (
    <div className="ig-pl-deck" id="ig-pipelines" data-testid="pipelines-deck">
      {/* mode toggle + workspace scope */}
      <div className="ig-pl-modebar">
        <button
          type="button"
          className="ig-btn"
          data-testid="pl-mode-builder"
          data-selected={mode === 'builder' ? 'true' : 'false'}
          onClick={() => setMode('builder')}
        >
          BUILDER
        </button>
        <button
          type="button"
          className="ig-btn"
          data-testid="pl-mode-monitor"
          data-selected={mode === 'monitor' ? 'true' : 'false'}
          onClick={() => setMode('monitor')}
        >
          RUN MONITOR
        </button>
        {mode === 'builder' && Object.keys(catalog).length > 1 ? (
          <select
            className="ig-pl-input ig-engraved"
            aria-label="palette workspace scope"
            data-testid="pl-workspace"
            value={workspace ?? ''}
            onChange={(e) => setWorkspace(e.target.value === '' ? undefined : e.target.value)}
          >
            <option value="">GLOBAL</option>
            {Object.keys(catalog)
              .filter((k) => k !== 'global')
              .map((k) => (
                <option key={k} value={k}>
                  {maskIdentityShapedText(k)}
                </option>
              ))}
          </select>
        ) : null}
      </div>

      {mode === 'builder' ? (
        <>
          <Palette groups={palette} onDrop={dropCapability} />
          <Canvas
            doc={doc}
            onAccount={onAccount}
            onNeeds={onNeeds}
            onRemove={onRemove}
            onAddGate={addGate}
          />
          {/* validate / save / launch — the frozen verbs */}
          <section
            className="ig-panel"
            data-testid="pl-verbs"
            data-status={verbStatus(verbState)}
          >
            <header className="ig-panel-header">
              <span className="ig-engraved">VERBS</span>
              <span className="ig-panel-readout ig-engraved" data-testid="pl-verb-readout">
                {verbReadout(verbState)}
              </span>
            </header>
            <div className="ig-panel-body">
              {verbState?.phase === 'answered' && verbState.valid === false ? (
                <div className="ig-engraved ig-status-fault" data-testid="pl-verb-issue">
                  {verbState.issueCode ?? 'bad-shape'}
                  {verbState.issuePath !== undefined && verbState.issuePath.length > 0
                    ? ` @ ${verbState.issuePath}`
                    : ''}
                </div>
              ) : null}
              <div className="ig-pl-verb-row">
                <button type="button" className="ig-btn" data-testid="pl-validate" onClick={onValidate}>
                  VALIDATE
                </button>
                <button type="button" className="ig-btn" data-testid="pl-save" onClick={onSave}>
                  SAVE
                </button>
                <button type="button" className="ig-btn" data-testid="pl-launch" onClick={onLaunch}>
                  LAUNCH
                </button>
              </div>
            </div>
          </section>
        </>
      ) : (
        <>
          {/* run list (left-zone fleet) */}
          <section className="ig-panel" data-testid="pl-run-list">
            <header className="ig-panel-header">
              <span className="ig-engraved">RUNS</span>
              <span className="ig-panel-readout ig-engraved" data-testid="pl-run-list-readout">
                {runs.length} RUN{runs.length === 1 ? '' : 'S'}
              </span>
            </header>
            <div className="ig-panel-body">
              {runs.length === 0 ? (
                <div className="ig-engraved ig-status-nosignal" data-testid="pl-run-list-empty">
                  NO RUNS
                </div>
              ) : (
                runs.map((run) => (
                  <div
                    key={run.runId}
                    className="ig-pl-run-row"
                    data-testid={`pl-run-${run.runId}`}
                    data-selected={run.runId === selectedRunId ? 'true' : 'false'}
                    data-status={runStatusRegister(run.state)}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedRunId(run.runId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setSelectedRunId(run.runId);
                    }}
                  >
                    <span className="ig-pl-step-id">{run.runId}</span>
                    <span className="ig-engraved">{RUN_STATE_READOUT[run.state]}</span>
                    {run.resumable === true ? (
                      <span className="ig-engraved" data-testid={`pl-run-resumable-${run.runId}`}>
                        RESUMABLE
                      </span>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>
          <RunMonitor run={selectedRun} sender={sender} mintRequestId={mintRequestId} />
        </>
      )}
    </div>
  );
}
