/**
 * FE-5 launch controller — framework-free state + dispatch orchestration.
 *
 * The views (view/views.ts) are pure state→markup functions; this controller
 * is the single mutation surface. The FE-2 shell binds DOM/React events to
 * {@link LaunchAction}s (every actionable element in the rendered markup
 * carries `data-action` attributes that {@link parseLaunchAction} decodes)
 * and re-renders on `subscribe`. No per-token state lives here — the
 * launcher's state changes are user-driven, well under the plan §5 streaming
 * discipline thresholds.
 *
 * Dispatch flow (feature 2/3):
 *   draft → validateLaunchDraft (frozen wire rules + feature-detect)
 *        → buildLaunchRequest (screened by the frozen validator)
 *        → LaunchControlPort.dispatch (FE-2 WS surface)
 *        → interpretLaunchResponse (frozen client-side validation)
 *        → history.record + TranscriptOpener(sessionId) on acceptance.
 */

import { isAccountLabel, type AccountLabel, type ErrorDetail } from '@aibender/protocol';

import type { LaunchRequest } from '@aibender/protocol';

import { validateLaunchDraft, emptyLaunchDraft } from './launchDraft.ts';
import type { DraftIssue, LaunchDraft, LaunchMode } from './launchDraft.ts';
import { featureAvailable, stubFeatureDetect, type FeatureDetectSnapshot } from './featureDetect.ts';
import { FREE_TEXT_CATALOG_SLOT, type SkillCatalogSlot } from './skill.ts';
import { LaunchHistoryStore } from './history.ts';
import { sequentialRequestIds } from './ports.ts';
import type { LaunchControlPort, RequestIdSource, TranscriptOpener } from './ports.ts';
import { buildLaunchRequest, interpretLaunchResponse } from './wire.ts';

export type DispatchPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'dispatching'; readonly requestId: string }
  | { readonly phase: 'accepted'; readonly sessionId: string }
  | { readonly phase: 'refused'; readonly issues: readonly DraftIssue[] }
  | { readonly phase: 'wire-error'; readonly error: ErrorDetail }
  | { readonly phase: 'failed'; readonly note: string };

export interface LauncherState {
  readonly draft: LaunchDraft;
  readonly dispatch: DispatchPhase;
}

export interface LaunchControllerDeps {
  readonly port: LaunchControlPort;
  readonly openTranscript: TranscriptOpener;
  readonly history?: LaunchHistoryStore;
  readonly detect?: FeatureDetectSnapshot;
  readonly catalog?: SkillCatalogSlot;
  readonly requestIds?: RequestIdSource;
}

export type LauncherListener = (state: LauncherState) => void;

// ---------------------------------------------------------------------------
// Actions — the DOM/React binding contract
// ---------------------------------------------------------------------------

export type EditableField = 'cwd' | 'purpose' | 'prompt' | 'skillText' | 'workstreamHint';

export type LaunchAction =
  | { readonly kind: 'select-account'; readonly label: AccountLabel }
  | { readonly kind: 'set-mode'; readonly mode: LaunchMode }
  | { readonly kind: 'set-field'; readonly field: EditableField; readonly value: string }
  | { readonly kind: 'submit' }
  | { readonly kind: 'clear-history' };

const EDITABLE_FIELDS: readonly EditableField[] = [
  'cwd',
  'purpose',
  'prompt',
  'skillText',
  'workstreamHint',
];

/**
 * Decode a rendered element's `data-*` attributes into an action. Returns
 * `undefined` for anything unknown or tampered — a DOM-injected label that is
 * not one of the five placeholders NEVER becomes a selection.
 */
export function parseLaunchAction(
  dataset: Readonly<Record<string, string | undefined>>,
  value?: string,
): LaunchAction | undefined {
  switch (dataset['action']) {
    case 'select-account': {
      const label = dataset['label'];
      return isAccountLabel(label) ? { kind: 'select-account', label } : undefined;
    }
    case 'set-mode': {
      const mode = dataset['mode'];
      return mode === 'prompt' || mode === 'skill' ? { kind: 'set-mode', mode } : undefined;
    }
    case 'set-field': {
      const field = dataset['field'];
      if (!(EDITABLE_FIELDS as readonly string[]).includes(field ?? '')) return undefined;
      return { kind: 'set-field', field: field as EditableField, value: value ?? '' };
    }
    case 'submit':
      return { kind: 'submit' };
    case 'clear-history':
      return { kind: 'clear-history' };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class LaunchController {
  readonly #port: LaunchControlPort;
  readonly #openTranscript: TranscriptOpener;
  readonly history: LaunchHistoryStore;
  readonly detect: FeatureDetectSnapshot;
  readonly catalog: SkillCatalogSlot;
  readonly #requestIds: RequestIdSource;
  readonly #listeners = new Set<LauncherListener>();
  #state: LauncherState;

  constructor(deps: LaunchControllerDeps) {
    this.#port = deps.port;
    this.#openTranscript = deps.openTranscript;
    this.history = deps.history ?? new LaunchHistoryStore();
    this.detect = deps.detect ?? stubFeatureDetect();
    this.catalog = deps.catalog ?? FREE_TEXT_CATALOG_SLOT;
    this.#requestIds = deps.requestIds ?? sequentialRequestIds();
    this.#state = { draft: emptyLaunchDraft(), dispatch: { phase: 'idle' } };
  }

  getState(): LauncherState {
    return this.#state;
  }

  subscribe(listener: LauncherListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  apply(action: LaunchAction): Promise<void> | undefined {
    switch (action.kind) {
      case 'select-account':
        this.#selectAccount(action.label);
        return undefined;
      case 'set-mode':
        this.#patchDraft({ mode: action.mode });
        return undefined;
      case 'set-field':
        this.#patchDraft({ [action.field]: action.value } as Partial<LaunchDraft>);
        return undefined;
      case 'submit':
        return this.submit();
      case 'clear-history':
        this.history.clear();
        return undefined;
    }
  }

  /**
   * A restricted account (for the CURRENT mode) is a disabled instrument:
   * the option renders aria-disabled and the controller ignores synthetic
   * select events for it too. Accounts restricted only for the other mode
   * remain selectable; a later mode switch is caught at submit.
   */
  #selectAccount(label: AccountLabel): void {
    if (!isAccountLabel(label)) return; // tampered action objects fail closed
    const feature = this.#state.draft.mode === 'prompt' ? 'oneOffPrompts' : 'skills';
    if (!featureAvailable(this.detect, label, feature)) return;
    this.#patchDraft({ account: label });
  }

  #patchDraft(patch: Partial<LaunchDraft>): void {
    this.#setState({
      draft: { ...this.#state.draft, ...patch },
      // Editing after a verdict returns the readout to idle.
      dispatch: { phase: 'idle' },
    });
  }

  /**
   * Validate, dispatch, record, and open the transcript island on the
   * returned session. Never throws: every failure lands in a dispatch phase
   * the readout renders.
   */
  async submit(): Promise<void> {
    const { draft } = this.#state;
    const verdict = validateLaunchDraft(draft, this.detect, this.catalog);
    if (!verdict.ok) {
      this.#setState({ draft, dispatch: { phase: 'refused', issues: verdict.issues } });
      return;
    }

    const requestId = this.#requestIds.next();
    let request: LaunchRequest;
    try {
      request = buildLaunchRequest(requestId, verdict.params);
    } catch (error) {
      // Unreachable when validateLaunchDraft passed; belt and braces.
      this.#setState({
        draft,
        dispatch: { phase: 'failed', note: error instanceof Error ? error.message : 'build failed' },
      });
      return;
    }

    this.#setState({ draft, dispatch: { phase: 'dispatching', requestId } });

    const params = verdict.params;
    const base = {
      kind: draft.mode,
      accountLabel: params.accountLabel,
      backend: params.backend,
      substrate: params.substrate,
      cwd: params.cwd,
      purpose: params.purpose,
      ...(params.workstreamHint !== undefined ? { workstreamHint: params.workstreamHint } : {}),
      promptText: params.prompt ?? '',
    } as const;

    let response: unknown;
    try {
      response = await this.#port.dispatch(request);
    } catch {
      // Transport failure — message content is NOT trusted into state.
      this.history.record({ ...base, outcome: 'failed', failureNote: 'transport' });
      this.#setState({ draft, dispatch: { phase: 'failed', note: 'TRANSPORT FAULT' } });
      return;
    }

    const outcome = interpretLaunchResponse(response, requestId);
    switch (outcome.kind) {
      case 'accepted': {
        this.history.record({ ...base, outcome: 'accepted', sessionId: outcome.sessionId });
        this.#setState({ draft, dispatch: { phase: 'accepted', sessionId: outcome.sessionId } });
        this.#openTranscript(outcome.sessionId);
        return;
      }
      case 'wire-error': {
        this.history.record({ ...base, outcome: 'wire-error', errorCode: outcome.error.code });
        this.#setState({ draft, dispatch: { phase: 'wire-error', error: outcome.error } });
        return;
      }
      case 'invalid': {
        this.history.record({ ...base, outcome: 'failed', failureNote: 'invalid-response' });
        this.#setState({ draft, dispatch: { phase: 'failed', note: 'INVALID RESPONSE' } });
        return;
      }
    }
  }

  #setState(next: LauncherState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
  }
}
