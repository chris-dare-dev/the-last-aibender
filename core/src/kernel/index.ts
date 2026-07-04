/**
 * core/src/kernel — BE-1 session kernel & account runtime (plan §4/BE-1;
 * blueprint §3 rules 1–6, §4.1) plus the BE-2 M2 slices: the pty/
 * subdirectory (attended sessions, login bootstrap, recycle v0 — re-exported
 * below) and the ApprovalBroker seam (approvals.ts) with its canUseTool
 * wiring into the SDK lifecycle.
 */

export {
  BareModeRefusedError,
  DoubleResumeError,
  KernelError,
  KernelShutdownError,
  LiveSpawnDisabledError,
  ProfileConfigError,
  SessionNotFoundKernelError,
  SessionNotResumableError,
  TokenMixingError,
  UnknownProfileError,
} from './errors.js';

export {
  CLAUDE_PROFILE_LABELS,
  DEFAULT_PROFILES_MANIFEST,
  aibenderHomePath,
  createProfileRegistry,
  isClaudeProfileLabel,
  parseProfilesManifest,
  type ClaudeProfile,
  type ClaudeProfileLabel,
  type ProfileRegistry,
  type ProfileRegistryOptions,
  type ProfilesManifest,
} from './profiles.js';

export {
  OAUTH_TOKEN_ENV_VAR,
  SCRUBBED_ENV_PREFIXES,
  SCRUBBED_ENV_VARS,
  assertNoForbiddenArgs,
  buildOtelEnvBlock,
  buildSessionEnv,
  isScrubbedEnvVar,
  type BuildSessionEnvOptions,
} from './env.js';

export {
  rawOfRunnerMessage,
  type QueryHandle,
  type QueryRunner,
  type QuerySpec,
  type RunnerInitMessage,
  type RunnerMessage,
  type RunnerMessageTap,
  type RunnerOtherMessage,
  type RunnerResultMessage,
} from './queryRunner.js';

export {
  createSdkQueryRunner,
  resolveBundledClaudeExecutable,
  type QueryFn,
  type SdkQueryLike,
  type SdkQueryRunnerOptions,
} from './sdkQueryRunner.js';

export { defaultPidLivenessProbe, type PidLivenessProbe } from './pidLiveness.js';

// BE-2 (M2): ApprovalBroker seam + canUseTool bridge ---------------------------
export {
  DEFAULT_APPROVAL_TTL_MS,
  approvalRelayFromBroker,
  createApprovalBroker,
  createCanUseToolBridge,
  type ApprovalBroker,
  type ApprovalBrokerOptions,
  type ApprovalRequestInput,
  type ApprovalResolution,
  type CanUseToolBridgeContext,
  type KernelApprovalRelay,
  type PendingApprovalHandle,
} from './approvals.js';

export {
  type CanUseToolContext,
  type CanUseToolHandler,
  type CanUseToolResult,
} from './queryRunner.js';

// BE-2 (M2): ptyHost, attended sessions, login bootstrap -----------------------
export * from './pty/index.js';

export {
  validateTranscriptTail,
  validateTranscriptTailFile,
  type TranscriptTailVerdict,
} from './transcriptTail.js';

export {
  createSessionKernel,
  defaultTranscriptLocator,
  projectDirSlug,
  type KernelSession,
  type ResumeOptions,
  type ResumeOutcome,
  type SessionExit,
  type SessionKernel,
  type SessionKernelOptions,
  type TranscriptLocator,
  type TranscriptRef,
} from './sessionKernel.js';
