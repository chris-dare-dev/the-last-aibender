/**
 * core/src/kernel — BE-1 session kernel & account runtime (plan §4/BE-1;
 * blueprint §3 rules 1–6, §4.1). Public surface for the composition root
 * (core/src/main/) and, later, the gateway's control verbs (BE-3).
 *
 * The pty/ subdirectory (attended sessions, login bootstrap) is BE-2, M2 —
 * deliberately absent here.
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
  type QueryHandle,
  type QueryRunner,
  type QuerySpec,
  type RunnerInitMessage,
  type RunnerMessage,
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
