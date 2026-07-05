/**
 * core/src/gateway — BE-3 Gateway & protocol runtime (M2 FULL slice; plan
 * §4/BE-3, contract docs/contracts/ws-protocol.md FROZEN-M2). Public surface
 * consumed by the composition root (core/src/main/, BE-ORCH):
 *
 *   const handle = await startGateway({
 *     kernel,        // BE-1 adapter (M1)
 *     ptyHost,       // BE-2 ptyHost adapter        (M2, optional)
 *     approvals,     // BE-2 ApprovalBroker adapter (M2, optional)
 *     transcripts,   // kernel SDK message tap      (M2, optional)
 *   });
 *   handle.publishQuota(snapshot);        // M3-source pass-throughs
 *   handle.publishContextTouch(touch);
 *   handle.publishEvent(draftPayload);
 *   ...
 *   await handle.close();
 *
 * fakeKernel.ts is a TEST DOUBLE and is deliberately NOT exported here —
 * production wiring cannot reach it through the package surface. The M2
 * port doubles (FakePtyHost, FakePtySession, FakeApprovalBroker,
 * FakeTranscriptSource) live in @aibender/testkit (ICR-0007).
 */

export {
  BOOTSTRAP_DIR_MODE,
  BOOTSTRAP_FILE_MODE,
  BOOTSTRAP_FILE_NAME,
  bootstrapDir,
  bootstrapPath,
  isGatewayBootstrap,
  readBootstrapFile,
  removeBootstrapFile,
  resolveAibenderHome,
  writeBootstrapFile,
  type BootstrapPathOptions,
  type GatewayBootstrap,
} from './bootstrap.js';

export {
  KernelVerbError,
  isKernelVerbError,
  type GatewayKernel,
  type KernelKillParams,
  type KernelKillResult,
  type KernelLaunchResult,
  type KernelResumeParams,
  type KernelResumeResult,
} from './kernel.js';

export type {
  ApprovalBrokerPort,
  ApprovalDecisionOutcome,
  GatewayPtyHost,
  GatewayPtySession,
  TranscriptSource,
  Unsubscribe,
  WorkstreamEnginePort,
} from './ports.js';

export {
  DEFAULT_PTY_FLOW_CONTROL,
  PtyBufferOverflowError,
  PtySessionStream,
  type PtyAttachResult,
  type PtyConsumerHandle,
  type PtyDeliverySink,
  type PtyFlowControlOptions,
  type PtyStreamProducer,
  type PtyStreamResult,
  type PtyStreamStats,
} from './ptyStream.js';

export {
  ChannelJournal,
  DEFAULT_JOURNAL_MAX_ENTRIES,
  JournalSet,
  type JournalEntry,
  type JournalReplayResult,
} from './journal.js';

export { createTranscriptProjector, type TranscriptProjector } from './transcriptProjector.js';

export { GATEWAY_TOKEN_BYTES, isTokenShaped, newBootToken, tokensMatch } from './token.js';

export {
  GATEWAY_HOST,
  GATEWAY_MAX_INBOUND_BYTES,
  startGateway,
  type GatewayHandle,
  type GatewayOptions,
} from './server.js';
