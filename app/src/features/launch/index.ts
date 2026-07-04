/**
 * FE-5 launch feature — public surface (plan §5/FE-5, M2 slice: features
 * 2 & 3 launchers; the observability dashboards are the M3 slice and live in
 * app/src/features/observability/).
 *
 * Composition (for the FE-2 shell):
 *
 *   const controller = new LaunchController({
 *     port,            // FE-2 WS client — control-channel dispatch (ports.ts)
 *     openTranscript,  // FE-3 transcript island opener
 *     history: new LaunchHistoryStore({ storage: window.localStorage }),
 *   });
 *   render: launchPanelView(controller.getState(), controller.detect,
 *                           controller.history.list(), controller.catalog)
 *   events: parseLaunchAction(el.dataset, value) → controller.apply(action)
 *
 * The views are pure and framework-portable (view/html.ts explains why they
 * are not React YET); the controller is the only mutation surface.
 */

export {
  sequentialRequestIds,
  type Clock,
  type LaunchControlPort,
  type RequestIdSource,
  type TranscriptOpener,
} from './ports.ts';

export { accountPickerOptions, type AccountPickerOption } from './accounts.ts';

export {
  capabilitiesFor,
  featureAvailable,
  stubFeatureDetect,
  withAccountCapabilities,
  type AccountCapabilities,
  type FeatureDetectSnapshot,
} from './featureDetect.ts';

export {
  FREE_TEXT_CATALOG_SLOT,
  MAX_SKILL_ARGS_CHARS,
  SKILL_NAME_RE,
  composeSkillPrompt,
  parseSkillCommand,
  skillIssueReadout,
  type SkillCatalogEntry,
  type SkillCatalogSlot,
  type SkillInvocation,
  type SkillParseIssue,
  type SkillParseResult,
} from './skill.ts';

export {
  emptyLaunchDraft,
  validateLaunchDraft,
  type DraftField,
  type DraftIssue,
  type DraftValidation,
  type LaunchDraft,
  type LaunchMode,
} from './launchDraft.ts';

export {
  buildLaunchRequest,
  controlEnvelope,
  interpretLaunchResponse,
  serializeControlFrame,
  type LaunchOutcome,
} from './wire.ts';

export {
  DEFAULT_HISTORY_LIMIT,
  LAUNCH_HISTORY_STORAGE_KEY,
  LaunchHistoryStore,
  MASKED,
  PROMPT_PREVIEW_CHARS,
  maskIdentityShapedText,
  type HistoryListener,
  type LaunchHistoryEntry,
  type LaunchHistoryOutcome,
  type LaunchHistoryStoreOptions,
  type StorageLike,
} from './history.ts';

export {
  LaunchController,
  parseLaunchAction,
  type DispatchPhase,
  type EditableField,
  type LaunchAction,
  type LaunchControllerDeps,
  type LauncherListener,
  type LauncherState,
} from './controller.ts';

export {
  collectNodes,
  escapeHtml,
  h,
  renderToHtml,
  textContent,
  type VNode,
} from './view/html.ts';

export {
  accountPickerView,
  dispatchReadoutView,
  launchHistoryView,
  launchPanelView,
  promptComposerView,
  skillComposerView,
} from './view/views.ts';
