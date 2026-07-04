/**
 * @aibender/testkit — synthesized fixture generators + fake servers for the
 * whole workspace (plan §3/§9.5; owner BE-ORCH, contributions via ICR).
 *
 * FIXTURE POLICY [X2]: every fixture is SYNTHESIZED — never copied from a real
 * transcript. Fixture identities use only the sanctioned placeholder labels
 * and obviously-fake values; generators actively REFUSE identity-shaped text
 * (see jsonl.ts).
 *
 * Surface:
 *   - jsonl.ts               synthesized JSONL transcript-line generator (M0)
 *   - transcriptFixtures.ts  transcript-tail fixtures (ICR-0001, from BE-1)
 *   - fakeQueryRunner.ts     the canonical QueryRunner double (ICR-0001)
 *   - fakeKernel.ts          gateway-facing kernel double (ICR-0002)
 *   - wsGolden.ts            golden WS-protocol fixture corpus (ICR-0003;
 *                            extended at the M2 full freeze and again at the
 *                            M3 events freeze — corpus pins
 *                            GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M3')
 *   - hooksGolden.ts         golden hook-POST fixture corpus
 *                            (hooks-contract.md §6, landed at the M3 freeze)
 *   - fakePtyBackend.ts      scripted PtyBackend + synthetic login TUI
 *                            byte source (ICR-0006, from BE-2)
 *   - fakeGatewayPorts.ts    gateway M2 port doubles: FakePtyHost,
 *                            FakeApprovalBroker, FakeTranscriptSource
 *                            (ICR-0007, from BE-3)
 *   - mockOpencodeServer.ts  mock OpenCode /global/event SSE server
 *                            (ICR-0008, from BE-4)
 *   - fakeLmStudio.ts        fake LM Studio /v1 + /api/v0 (ICR-0008)
 *   - fakeOpencodeDb.ts      fake opencode.db builder (ICR-0008)
 *   - statuslineFeed.ts      fake statusline stdin feed: payload generator +
 *                            tee-file writer (ICR-0010, from BE-5)
 *   - otlpEmitter.ts         fake OTLP http/json emitter: attr/batch/
 *                            api_request builders (ICR-0010, from BE-5)
 *
 * The plan §3 "still to come" list is now fully landed (ICR-0010 closed it).
 */

export {
  PLACEHOLDER_ACCOUNTS,
  assertSynthesizedSafeText,
  synthesizedJsonlLine,
  type PlaceholderAccount,
  type SynthesizedJsonlLineOptions,
} from './jsonl.js';

export {
  synthesizedTranscript,
  type SynthesizedTranscript,
  type SynthesizedTranscriptOptions,
  type SynthesizedTranscriptStep,
} from './transcriptFixtures.js';

export {
  type CanUseToolContext,
  type CanUseToolHandler,
  type CanUseToolResult,
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
  FakeQueryRunner,
  type FakeQueryRunnerOptions,
  type FakeSession,
} from './fakeQueryRunner.js';

export {
  FAKE_PTY_EXECUTABLE,
  FakePtyBackend,
  FakePtyProcess,
  SYNTHETIC_LOGIN_BANNER,
  SYNTHETIC_LOGIN_SUCCESS,
  asciiBytes,
  syntheticLoginTui,
  type FakePtyBackendOptions,
  type PtyBackend,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnSpec,
} from './fakePtyBackend.js';

export {
  FakeApprovalBroker,
  FakePtyHost,
  FakePtySession,
  FakeTranscriptSource,
  type ApprovalBrokerPort,
  type ApprovalDecisionOutcome,
  type GatewayPtyHost,
  type GatewayPtySession,
  type TranscriptSource,
  type Unsubscribe,
} from './fakeGatewayPorts.js';

export {
  startMockOpencodeServer,
  type MockBusEventInput,
  type MockDurableSessionEvent,
  type MockOpencodeServer,
  type MockOpencodeServerOptions,
  type RecordedRequest,
} from './mockOpencodeServer.js';

export {
  startFakeLmStudioServer,
  type FakeLmStudioModel,
  type FakeLmStudioServer,
  type RecordedChatRequest,
} from './fakeLmStudio.js';

export {
  SYNTHETIC_CREDENTIAL_VALUE,
  buildFakeOpencodeDb,
  type FakeOpencodeDb,
  type FakeOpencodeDbOptions,
  type FakeOpencodeDbSession,
} from './fakeOpencodeDb.js';

export {
  FakeKernel,
  FakeKernelVerbError,
  isKernelVerbErrorLike,
  type FakeKernelOptions,
  type GatewayKernel,
  type KernelKillParams,
  type KernelKillResult,
  type KernelLaunchResult,
  type KernelResumeParams,
  type KernelResumeResult,
  type KernelVerbErrorLike,
} from './fakeKernel.js';

export {
  GOLDEN_WS_CORPUS_FREEZE,
  GOLDEN_WS_FIXTURES,
  goldenFrameBytes,
  replayGoldenWsFixture,
  type GoldenWsBinaryFixture,
  type GoldenWsDirection,
  type GoldenWsExpectation,
  type GoldenWsFixture,
  type GoldenWsReplayResult,
  type GoldenWsStage,
  type GoldenWsTextFixture,
} from './wsGolden.js';

export {
  GOLDEN_HOOK_CORPUS_FREEZE,
  GOLDEN_HOOK_FIXTURES,
  replayGoldenHookFixture,
  type GoldenHookExpectation,
  type GoldenHookFixture,
  type GoldenHookReplayResult,
} from './hooksGolden.js';

export {
  synthesizedStatuslinePayload,
  writeStatuslineTee,
  type StatuslineWindowInput,
  type SynthesizedStatuslinePayloadOptions,
  type WriteStatuslineTeeOptions,
} from './statuslineFeed.js';

export {
  SYNTHETIC_OTLP_ACCOUNT_UUID,
  SYNTHETIC_OTLP_API_REQUEST_TS_MS,
  SYNTHETIC_OTLP_EMAIL,
  otlpApiRequestRecord,
  otlpAttr,
  otlpLogsBatch,
  type OtlpLogsBatchOptions,
} from './otlpEmitter.js';
