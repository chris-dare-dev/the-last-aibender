/**
 * core/src/adapters/opencode — the OpenCode→Bedrock backend adapter (BE-4;
 * blueprint §4.2). Public surface for the composition root, BE-5's collector
 * (SSE stream + db reader) and BE-9's supervisor (argv match + RSS logic).
 */

export {
  OPENCODE_BASIC_USERNAME,
  SERVE_PASSWORD_BYTES,
  isServePasswordShaped,
  newServePassword,
  serveBasicAuthHeader,
} from './password.js';

export {
  findServeProcesses,
  matchesOpencodeServeArgv,
  type ProcessArgvRow,
} from './argv.js';

export {
  DEFAULT_RSS_SUSTAIN_MS,
  DEFAULT_RSS_THRESHOLD_BYTES,
  createSustainedRssTracker,
  type RssSampleVerdict,
  type SustainedRssTracker,
  type SustainedRssTrackerOptions,
} from './watchdog.js';

export {
  buildBedrockEnv,
  createKeychainSecretFetcher,
  type BedrockEnvSpec,
  type BuildBedrockEnvOptions,
  type ExecFileFn,
  type KeychainEnvVarSpec,
  type KeychainSecretFetcherOptions,
  type SecretFetcher,
} from './secrets.js';

export {
  createOpencodeServeSupervisor,
  parseListeningLine,
  pickFreePort,
  realSpawnServe,
  type OpencodeServeHandle,
  type OpencodeServeSupervisor,
  type OpencodeServeSupervisorOptions,
  type ServeChild,
  type ServeExit,
  type ServeHealth,
  type SpawnServeCommand,
  type SpawnServeFn,
} from './serve.js';

export {
  createOpencodeSseTransport,
  parseSseStream,
  type OpencodeDurableEvent,
  type OpencodeEvent,
  type OpencodeSseTransport,
  type OpencodeSseTransportOptions,
  type OpencodeSyncCorrelation,
  type SseMessage,
  type SseTransportState,
  type SseTransportStats,
} from './sse.js';

export {
  createOpencodeSessionClient,
  type CreateOpencodeSessionInput,
  type OpencodeSessionClient,
  type OpencodeSessionClientOptions,
  type OpencodeSessionInfo,
} from './client.js';

export {
  FORBIDDEN_OPENCODE_TABLES,
  assertGuardedOpencodeSql,
  openOpencodeDbReadOnly,
  stripSqlLiteralsAndComments,
  type GuardedOpencodeDb,
  type OpenOpencodeDbOptions,
} from './dbAccess.js';
