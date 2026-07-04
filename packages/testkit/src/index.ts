/**
 * @aibender/testkit — synthesized fixture generators + fake servers for the
 * whole workspace (plan §3/§9.5; owner BE-ORCH, contributions via ICR).
 *
 * FIXTURE POLICY [X2]: every fixture is SYNTHESIZED — never copied from a real
 * transcript. Fixture identities use only the sanctioned placeholder labels
 * and obviously-fake values; generators actively REFUSE identity-shaped text
 * (see jsonl.ts).
 *
 * M1 surface:
 *   - jsonl.ts               synthesized JSONL transcript-line generator (M0)
 *   - transcriptFixtures.ts  transcript-tail fixtures (ICR-0001, from BE-1)
 *   - fakeQueryRunner.ts     the canonical QueryRunner double (ICR-0001)
 *   - fakeKernel.ts          gateway-facing kernel double (ICR-0002)
 *   - wsGolden.ts            golden WS-protocol fixture corpus (ICR-0003)
 *
 * Still to come per plan §3: fake statusline stdin feed, fake OTLP emitter,
 * mock OpenCode SSE server, fake opencode.db builder, fake LM Studio.
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
