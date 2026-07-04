/**
 * core/src/readmodels — BE-6 dashboard read models over the M3 events store
 * (plan §4/BE-6, blueprint §6.3): per-source freshness states (never
 * errors), the ten dashboard leads, ccusage-cited 5h-block burn math, the
 * local-model correction-intent classifier, and the validated publisher
 * feeding the gateway's quota + events channels.
 */

export {
  DEFAULT_FRESH_WINDOW_MS,
  DEFAULT_SOURCE_WINDOWS_MS,
  FRESHNESS_CONDITIONS,
  createFreshnessTracker,
  isFreshnessCondition,
  type FreshnessCondition,
  type FreshnessTracker,
  type FreshnessTrackerOptions,
} from './freshness.js';

export {
  BLOCK_DURATION_MS,
  MIN_ELAPSED_MS,
  activeBlock,
  assembleBlocks,
  burnRateTokensPerHour,
  floorToUtcHour,
  projectExhaustionAt,
  type BlockEntry,
  type ExhaustionInput,
  type UsageBlock,
} from './blocks.js';

export {
  COST_EXPLORER_LAG_HOURS,
  MIN_COHORT_FOR_FLAGS,
  MIN_INVOCATIONS_FOR_FLAG,
  MIN_OUTCOMES_FOR_RATE,
  apiEquivalentUsdData,
  bedrockCostData,
  burnRateData,
  cacheHitRateData,
  estimateUsdForRow,
  healthData,
  latencyData,
  localOffloadData,
  percentile,
  quotaGaugesData,
  sessionOutcomesData,
  skillLeaderboardData,
  tokensOfRow,
  type BedrockCostResult,
  type BurnRateInputs,
  type ReadModelStores,
  type SkillLeaderboardInputs,
} from './projections.js';

export {
  CLASSIFIER_SYSTEM_PROMPT,
  createCorrectionIntentClassifier,
  parseVerdict,
  type CorrectionClassifierOptions,
  type CorrectionIntentClassifier,
  type CorrectionJob,
  type CorrectionTally,
  type DrainOutcome,
} from './classification.js';

export {
  DEFAULT_READ_MODEL_SOURCES,
  createReadModelPublisher,
  type ReadModelPublisher,
  type ReadModelPublisherOptions,
  type ReadModelSink,
} from './publisher.js';
