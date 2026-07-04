/**
 * core/src/kernel/pty — BE-2 ptyHost, attended sessions, login bootstrap
 * (plan §4/BE-2; blueprint §4.1 "Interactive attended" row; ws-protocol.md
 * §5/§6 producer side; SPIKE-D vi/vii mechanics).
 *
 * Public surface for the composition root (core/src/main/, BE-ORCH) and the
 * BE-3 gateway's pty channel slice. PTY semantics are NEVER parsed from
 * bytes — architecture.spec.ts enforces the absence of parser imports here.
 *
 * The pty test doubles (FakePtyBackend, syntheticLoginTui) live in
 * @aibender/testkit (promoted via ICR-0006, the ICR-0001 path).
 */

export {
  AckRingOverflowError,
  BoundedAckRing,
  DEFAULT_FLOW_CONTROL,
  type AckRingStats,
  type FlowControlConfig,
  type OffsetChunk,
} from './flowControl.js';

export {
  createNodePtySpawner,
  ensureSpawnHelperExecutable,
  type NodePtyModuleLike,
  type NodePtySpawnerOptions,
  type PtyBackend,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnSpec,
} from './ptyBackend.js';

export {
  toApprovalBrokerGatewayPort,
  toGatewayPtyHostPort,
  type ApprovalBrokerGatewayPort,
  type ApprovalDecisionPortOutcome,
  type GatewayPtyHostPort,
  type GatewayPtySessionPort,
  type Unsubscribe,
} from './gatewayPort.js';

export {
  createPtyHost,
  defaultPtyArgv,
  noopContinuationEdgeEmitter,
  type AttendedPtySession,
  type ContinuationEdgeEmitter,
  type ContinuationEdgeEvent,
  type LoginBootstrapOptions,
  type PtyArgvBuilder,
  type PtyArgvContext,
  type PtyHost,
  type PtyHostExit,
  type PtyHostOptions,
  type PtyOutputConsumer,
  type RecycleOptions,
  type RecycleOutcome,
} from './ptyHost.js';
