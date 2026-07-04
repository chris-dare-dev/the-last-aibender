/**
 * core/src/adapters/lmstudio — the local-tier backend adapter (BE-4;
 * blueprint §4.3). Host-native by construction: 127.0.0.1 base URLs only,
 * zero k8s/colima imports ([X3] — the standing architectural test).
 */

export {
  DEFAULT_HEALTH_TIMEOUT_MS,
  createLmStudioHealthProbe,
  type LmStudioDownReason,
  type LmStudioHealth,
  type LmStudioHealthProbe,
  type LmStudioHealthProbeOptions,
} from './health.js';

export {
  createLmStudioClient,
  type LmStudioChatCompletion,
  type LmStudioChatMessage,
  type LmStudioChatRequest,
  type LmStudioChatResult,
  type LmStudioClient,
  type LmStudioClientOptions,
  type LmStudioUsage,
} from './client.js';

export {
  createLmStudioApiV0Reader,
  type ApiV0ModelsResult,
  type LmStudioApiV0Reader,
  type LmStudioApiV0ReaderOptions,
  type LmStudioModelResidency,
  type LmStudioModelState,
} from './apiV0.js';

export {
  createLmsCliLifecycle,
  verifyUnload,
  type LmsCliLifecycleOptions,
  type LmsExecFn,
  type LmsLifecycle,
  type LmsVerbResult,
  type UnloadVerification,
  type VerifyUnloadOptions,
} from './lifecycle.js';

export {
  AMBER_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  createResidencyLedger,
  createResidencyPolicy,
  ttlForPressure,
  type LoadDecision,
  type LoadEvaluationContext,
  type LocalModelServer,
  type LocalModelSpec,
  type PressureState,
  type ResidencyLedger,
  type ResidencyPolicy,
  type ResidencyPolicyOptions,
  type ResidentEntry,
} from './residency.js';
