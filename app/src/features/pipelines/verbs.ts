/**
 * FE-6 pipeline verbs — the client half of the six FROZEN pipeline verbs
 * (ws-protocol.md §18.2): build the payload in the golden-corpus key order,
 * validate it through the EXACT frozen validator the broker runs, dispatch it
 * on the pipelines channel, and track the correlated ending (the merge.ts
 * precedent for the workstream verb).
 *
 * Client-side validation delegates to `validatePipelineClientMessage` — so
 * anything this module refuses (`blocked`) is precisely what the broker would
 * answer `bad-request` to. The server stays the authority for everything
 * actually sent: a saved `pipelineId` that resolves to nothing, an unknown
 * `runId`, a launch whose DAG references a capability that no longer exists —
 * these are RUNTIME state and only the broker can judge them (answered by the
 * §18.4 pushed errors, correlated by requestId, applied via bind.ts).
 *
 * Wire-shape discipline: {@link buildValidateRequest} / {@link buildSaveRequest}
 * carry the CANONICAL document (dagModel.ts — the validator's sanitized form,
 * byte-identical to the corpus once the corpus fixture is canonicalized the
 * same way); the launch/run verbs follow the golden fixture key order
 * (`{kind, requestId, pipelineId?, document?, inputs?, workstreamId?}`,
 * `{kind, requestId, runId}`) so an encoded envelope is byte-comparable
 * against `pipelines-*-valid` (lib/ws/outbound.ts corpus device).
 */

import {
  validatePipelineClientMessage,
  type DagDocument,
  type ErrorCode,
  type PipelineCancelRequest,
  type PipelineClientPayload,
  type PipelineLaunchRequest,
  type PipelinePauseRequest,
  type PipelineResumeRequest,
  type PipelineSaveRequest,
  type PipelineValidateRequest,
} from '@aibender/protocol';
import type { PipelineVerbSender } from './ports.ts';
import type { PipelineClientVerbLabel, PipelinesStore, VerbState } from './store.ts';

// ---------------------------------------------------------------------------
// Payload builders — golden-corpus key order (byte-comparable, §18.2 corpus)
// ---------------------------------------------------------------------------

export function buildValidateRequest(
  requestId: string,
  document: DagDocument,
): PipelineValidateRequest {
  return { kind: 'pipeline-validate', requestId, document };
}

export function buildSaveRequest(requestId: string, document: DagDocument): PipelineSaveRequest {
  return { kind: 'pipeline-save', requestId, document };
}

export interface LaunchArgs {
  readonly pipelineId?: string;
  readonly document?: DagDocument;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly workstreamId?: string;
}

/** EXACTLY ONE of pipelineId | document (the validator enforces; §18.2). */
export function buildLaunchRequest(requestId: string, args: LaunchArgs): PipelineLaunchRequest {
  return {
    kind: 'pipeline-launch',
    requestId,
    ...(args.pipelineId !== undefined ? { pipelineId: args.pipelineId } : {}),
    ...(args.document !== undefined ? { document: args.document } : {}),
    ...(args.inputs !== undefined ? { inputs: args.inputs } : {}),
    ...(args.workstreamId !== undefined ? { workstreamId: args.workstreamId } : {}),
  };
}

export function buildPauseRequest(requestId: string, runId: string): PipelinePauseRequest {
  return { kind: 'pipeline-pause', requestId, runId };
}

export function buildResumeRequest(requestId: string, runId: string): PipelineResumeRequest {
  return { kind: 'pipeline-resume', requestId, runId };
}

export function buildCancelRequest(requestId: string, runId: string): PipelineCancelRequest {
  return { kind: 'pipeline-cancel', requestId, runId };
}

// ---------------------------------------------------------------------------
// Validate → send → track (never throws; every ending is a tracked state)
// ---------------------------------------------------------------------------

export type VerbVerdict =
  | { readonly ok: true; readonly message: PipelineClientPayload }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** Validate a verb payload through the FROZEN client-message validator. */
export function validateVerb(message: PipelineClientPayload): VerbVerdict {
  const verdict = validatePipelineClientMessage(message);
  return verdict.ok
    ? { ok: true, message: verdict.value }
    : { ok: false, code: verdict.code, message: verdict.message };
}

/** Dispatch outcome — mirrors the store's local endings (§18.4 fills failed later). */
export type DispatchOutcome = 'blocked' | 'unsendable' | 'pending';

export interface DispatchOptions {
  readonly store: PipelinesStore;
  readonly sender: PipelineVerbSender | undefined;
}

function verbLabelOf(message: PipelineClientPayload): PipelineClientVerbLabel {
  return message.kind;
}

/**
 * Validate → send → track. Never throws; every ending is a tracked instrument
 * state (the §18.4 error contract fills in `failed` later via bind.ts).
 */
export function dispatchVerb(
  message: PipelineClientPayload,
  options: DispatchOptions,
): DispatchOutcome {
  const track = (state: VerbState): void => options.store.getState().trackVerb(state);
  const requestId = message.requestId;
  const verb = verbLabelOf(message);
  const verdict = validateVerb(message);
  if (!verdict.ok) {
    track({ requestId, verb, phase: 'blocked', code: verdict.code });
    return 'blocked';
  }
  const sent = options.sender?.sendPipelineMessage(verdict.message) ?? false;
  if (!sent) {
    track({ requestId, verb, phase: 'unsendable' });
    return 'unsendable';
  }
  track({ requestId, verb, phase: 'pending' });
  return 'pending';
}
