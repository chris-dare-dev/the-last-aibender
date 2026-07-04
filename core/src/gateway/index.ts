/**
 * core/src/gateway — BE-3 Gateway & protocol runtime (M1 slice: control
 * channel only). Public surface consumed by the composition root
 * (core/src/main/, BE-ORCH):
 *
 *   const handle = await startGateway({ kernel });   // kernel = BE-1 adapter
 *   ...
 *   await handle.close();
 *
 * M2 adds: PTY byte streaming + ack-watermark flow control, transcript/
 * events/quota/approvals channels, reconnect replay (plan §4/BE-3;
 * docs/contracts/ws-protocol.md).
 *
 * fakeKernel.ts is a TEST DOUBLE and is deliberately NOT exported here —
 * production wiring cannot reach it through the package surface.
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

export { GATEWAY_TOKEN_BYTES, isTokenShaped, newBootToken, tokensMatch } from './token.js';

export {
  GATEWAY_HOST,
  GATEWAY_MAX_INBOUND_BYTES,
  startGateway,
  type GatewayHandle,
  type GatewayOptions,
} from './server.js';
