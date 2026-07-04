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
 *                            extended at the M2 full freeze — corpus pins
 *                            GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M2')
 *   - fakePtyBackend.ts      scripted PtyBackend + synthetic login TUI
 *                            byte source (ICR-0006, from BE-2)
 *   - fakeGatewayPorts.ts    gateway M2 port doubles: FakePtyHost,
 *                            FakeApprovalBroker, FakeTranscriptSource
 *                            (ICR-0007, from BE-3)
 *   - mockOpencodeServer.ts  mock OpenCode /global/event SSE server
 *                            (ICR-0008, from BE-4)
 *   - fakeLmStudio.ts        fake LM Studio /v1 + /api/v0 (ICR-0008)
 *   - fakeOpencodeDb.ts      fake opencode.db builder (ICR-0008)
 *
 * Still to come per plan §3: fake statusline stdin feed, fake OTLP emitter,
 * synthesized hook-POST fixtures (hooks-contract.md §6, lands with BE-5 M3).
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
