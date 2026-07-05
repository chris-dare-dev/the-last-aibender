/**
 * FE-2 lib barrel — the surface islands (FE-3/FE-4) and features (FE-5/FE-6)
 * consume. Import from here rather than deep paths: the barrel is the
 * stability contract inside app/src.
 */

export {
  configuredClaudeAccountsFromBootstrap,
  discoverGateway,
  gatewayWsUrl,
  isGatewayBootstrap,
  sameBootIdentity,
  bootIdentityOf,
  type BootIdentity,
  type BootstrapProvider,
  type GatewayBootstrap,
} from './bootstrap.ts';

export { consoleLogger, nullLogger, type Logger } from './log.ts';

export { BoundedByteQueue, RingBuffer } from './buffers/ringBuffer.ts';

export {
  createRafProjector,
  defaultFrameScheduler,
  type FrameScheduler,
  type RafProjector,
  type RafProjectorOptions,
} from './projection/rafBatch.ts';

export {
  routeBrokerFrame,
  replayableChannelOf,
  seqOf,
  type InboundMessage,
  type InboundStage,
  type InboundVerdict,
} from './ws/inboundRouter.ts';

export { OutboundSeq, encodeEnvelope } from './ws/outbound.ts';

export {
  ControlRequestError,
  GatewayClient,
  type ClientEvents,
  type ClientPhase,
  type ControlRequestDraft,
  type GatewayClientOptions,
  type ProtocolViolation,
} from './ws/wsClient.ts';

export {
  PTY_CLIENT_QUEUE_CAP_BYTES,
  PtyConduit,
  type PtyBytesListener,
  type PtyConduitIo,
} from './ws/ptyConduit.ts';

export {
  WS_OPEN,
  platformTimers,
  platformWsFactory,
  type Timers,
  type WsCloseEvent,
  type WsFactory,
  type WsLike,
  type WsMessageEvent,
} from './ws/types.ts';

export { connectionStore, type ConnectionState } from './stores/connectionStore.ts';
export { sessionsStore, type SessionsStoreState } from './stores/sessionsStore.ts';
export {
  MAX_BLOCKS_PER_SESSION,
  transcriptStore,
  type SessionTranscript,
  type ToolEventRow,
  type TranscriptBatchItem,
  type TranscriptBlock,
  type TranscriptStoreState,
} from './stores/transcriptStore.ts';
export {
  approvalsStore,
  pendingApprovals,
  type ApprovalsStoreState,
  type PendingApproval,
  type ResolvedApproval,
} from './stores/approvalsStore.ts';
export { quotaKey, quotaStore, type QuotaKey, type QuotaStoreState } from './stores/quotaStore.ts';
export {
  contextGraphStore,
  type ContextGraphStoreState,
} from './stores/contextGraphStore.ts';
export {
  QUOTA_DEGRADED_PCT,
  deriveChannelReadings,
  type ChannelHealthInputs,
  type ChannelReading,
  type ChannelStatus,
} from './stores/channelHealth.ts';
export { bindClientToStores, type BindOptions } from './stores/bind.ts';

export { terminalPortForConduit } from './islands/terminalPort.ts';
export {
  MAX_FEED_SESSIONS,
  TranscriptFeedRegistry,
  transcriptFeeds,
} from './islands/transcriptFeeds.ts';

export {
  ENT_CAPABILITY_KEYS,
  detectEntCapabilities,
  entDegradedCapabilities,
  type EntCapabilities,
  type EntCapabilityKey,
  type EntCapabilityState,
} from './entCapabilities.ts';

export { isTauri, nativeBootstrapProvider, notifyNative } from './native/tauriBridge.ts';

export {
  SEED_CLAUDE_ACCOUNTS,
  accountRegistry,
  buildAccountRegistry,
  channelHueForLabel,
  currentConfiguredClaudeAccounts,
  normalizeClaudeAccounts,
  setConfiguredClaudeAccounts,
  type AccountKind,
  type AccountRegistry,
  type AccountRegistryEntry,
} from './accountRegistry.ts';
