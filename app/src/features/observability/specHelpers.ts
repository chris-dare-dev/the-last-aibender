/**
 * Spec-only builders for the observability suites (imported by *.spec files
 * exclusively — never by shipped modules). All values are synthesized; the
 * identity-shaped strings are runtime-built so no scanner-shaped literal is
 * committed to this public repo (testkit convention) [X2].
 */

import type {
  BedrockCostSnapshot,
  EventSource,
  QuotaGaugesSnapshot,
  ReadModelSnapshot,
  SessionOutcomesSnapshot,
  SkillLeaderboardSnapshot,
  SourceFreshness,
  SourceFreshnessState,
} from '@aibender/protocol';

export const T0 = 90_100_000;

export function src(
  state: SourceFreshnessState,
  source: EventSource = 'claude-quota',
  lastIngestAt?: number,
): SourceFreshness {
  return { source, state, ...(lastIngestAt !== undefined ? { lastIngestAt } : {}) };
}

export function quotaGaugesSnap(
  sources: readonly SourceFreshness[],
  gauges: QuotaGaugesSnapshot['data']['gauges'] = [
    { account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: T0 + 100_000 },
  ],
  capturedAt = T0,
): QuotaGaugesSnapshot {
  return { kind: 'read-model-snapshot', readModel: 'quota-gauges', capturedAt, sources, data: { gauges } };
}

export function bedrockSnap(
  sources: readonly SourceFreshness[],
  data: BedrockCostSnapshot['data'],
  capturedAt = T0,
): BedrockCostSnapshot {
  return { kind: 'read-model-snapshot', readModel: 'bedrock-cost', capturedAt, sources, data };
}

export function skillsSnap(
  entries: SkillLeaderboardSnapshot['data']['entries'],
  sources: readonly SourceFreshness[] = [src('fresh', 'claude-otel', T0 - 1000)],
  capturedAt = T0,
): SkillLeaderboardSnapshot {
  return {
    kind: 'read-model-snapshot',
    readModel: 'skill-leaderboard',
    capturedAt,
    sources,
    data: { entries },
  };
}

export function outcomesSnap(
  entries: SessionOutcomesSnapshot['data']['entries'],
  sources: readonly SourceFreshness[] = [src('fresh', 'claude-jsonl', T0 - 1000)],
  capturedAt = T0,
): SessionOutcomesSnapshot {
  return {
    kind: 'read-model-snapshot',
    readModel: 'session-outcomes',
    capturedAt,
    sources,
    data: { entries, windowDays: 7 },
  };
}

/** All ten leads populated with plain synthetic data at capture T0. */
export function fullDeckSnapshots(): ReadModelSnapshot[] {
  return [
    quotaGaugesSnap([src('fresh', 'claude-quota', T0 - 1000)]),
    {
      kind: 'read-model-snapshot',
      readModel: 'burn-rate',
      capturedAt: T0,
      sources: [src('fresh', 'claude-jsonl', T0 - 1000)],
      data: {
        entries: [
          {
            account: 'MAX_A',
            blockStartAt: T0 - 3_600_000,
            blockEndAt: T0 + 14_400_000,
            tokensPerHour: 120_000,
            usedPct: 30,
          },
        ],
      },
    },
    bedrockSnap([src('estimate-only', 'bedrock-cost-explorer')], { estimateMtdUsd: 12.5 }),
    {
      kind: 'read-model-snapshot',
      readModel: 'api-equivalent-usd',
      capturedAt: T0,
      sources: [src('fresh', 'claude-jsonl', T0 - 1000)],
      data: {
        basis: 'api-equivalent',
        entries: [{ account: 'ENT', backend: 'claude_code', equivalentUsd: 42 }],
        windowDays: 7,
      },
    },
    {
      kind: 'read-model-snapshot',
      readModel: 'cache-hit-rate',
      capturedAt: T0,
      sources: [src('fresh', 'claude-jsonl', T0 - 1000)],
      data: {
        entries: [
          {
            account: 'MAX_A',
            hitRatePct: 87.5,
            readTokens: 70_000,
            creation5mTokens: 4_000,
            creation1hTokens: 6_000,
          },
        ],
      },
    },
    {
      kind: 'read-model-snapshot',
      readModel: 'latency',
      capturedAt: T0,
      sources: [src('fresh', 'lmstudio', T0 - 1000)],
      data: {
        entries: [
          { backend: 'lmstudio', p50Ms: 300, p95Ms: 900, ttftP50Ms: 80, ttftP95Ms: 200, sampleCount: 40 },
        ],
      },
    },
    {
      kind: 'read-model-snapshot',
      readModel: 'health',
      capturedAt: T0,
      sources: [src('fresh', 'opencode-sse', T0 - 1000)],
      data: {
        entries: [
          {
            source: 'opencode-sse',
            errorCount: 0,
            retryCount: 0,
            throttleCount: 0,
            timeoutCount: 0,
            windowMinutes: 60,
          },
        ],
      },
    },
    skillsSnap([
      {
        skillName: 'synthetic-skill',
        invocations: 12,
        successRatePct: 75,
        tokensPerOutcome: 5400.5,
        worstQuartile: false,
      },
    ]),
    outcomesSnap([{ outcome: 'completed', count: 9 }]),
    {
      kind: 'read-model-snapshot',
      readModel: 'local-offload',
      capturedAt: T0,
      sources: [src('fresh', 'lmstudio', T0 - 1000)],
      data: { offloadRatioPct: 22.2, localTokens: 200, totalTokens: 900, windowDays: 7 },
    },
  ];
}

/** Identity-shaped adversarial strings (runtime-built — never literals). */
export function adversarialStrings(): { emailish: string; awsIdish: string; tokenish: string } {
  return {
    emailish: ['owner.real', 'example.com'].join('@'),
    awsIdish: '987654'.repeat(2),
    tokenish: ['sk', 'live0token0live0'].join('-'),
  };
}
