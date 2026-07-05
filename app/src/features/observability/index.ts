/**
 * FE-5 observability feature — public surface (plan §5/FE-5, M3 slice:
 * feature 1, the §6.3 instrument dashboards; the launchers are the M2 slice
 * in app/src/features/launch/).
 *
 * Composition (one line in the FE-2 composition root):
 *
 *   const dispose = registerObservability(client);
 *
 * Data path: broker `events` channel → GatewayClient (frozen validators)
 * → bindObservability (rAF projector, one store write per frame)
 * → observabilityStore (latest snapshot per frozen READ_MODEL_IDS entry)
 * → ObservabilityDeck (ten fixed instruments, blueprint §6.3 order),
 * joined with the FE-2 quota store for live gauge movement between
 * read-model recomputes. Degraded sources render as dimmed engraved states
 * with copy-command remediation affordances — never error toasts.
 */

export {
  latestSnapshot,
  observabilityStore,
  type ObservabilityStore,
  type ObservabilityStoreState,
  type ReadModelSlots,
} from './store.ts';

export { bindObservability, type EventsFeed, type ObservabilityBindOptions } from './bind.ts';

export {
  absentHealth,
  actualsAreHonest,
  deriveInstrumentHealth,
  escalate,
  freshnessClass,
  remediationFor,
  type FreshnessClass,
  type InstrumentHealth,
  type InstrumentReadout,
  type InstrumentStatus,
  type Remediation,
  type SourceStripEntry,
} from './freshness.ts';

export {
  fmtAge,
  fmtBytes,
  fmtCountdown,
  fmtMb,
  fmtMs,
  fmtPct,
  fmtTokens,
  fmtTokensPerHour,
  fmtUsd,
} from './format.ts';

export {
  FIXED_GAUGE_SLOTS,
  apiEquivalentVM,
  bedrockCostVM,
  burnRateVM,
  cacheHitVM,
  healthLeadVM,
  latencyVM,
  localOffloadVM,
  quotaGaugesVM,
  sessionOutcomesVM,
  skillLeaderboardVM,
  type ApiEquivalentRow,
  type ApiEquivalentVM,
  type BedrockCostVM,
  type BurnRateRow,
  type BurnRateVM,
  type CacheHitRow,
  type CacheHitVM,
  type HealthLeadVM,
  type LatencyVM,
  type LocalOffloadVM,
  type OutcomeRow,
  type QuotaGaugeRow,
  type QuotaGaugesVM,
  type SessionOutcomesVM,
  type SkillLeaderboardVM,
  type SkillRow,
} from './instruments.ts';

export {
  DASHBOARD_READ_MODEL_IDS,
  DECK_TICK_MS,
  INSTRUMENT_LABELS,
  MAX_LEADERBOARD_ROWS,
  ObservabilityDeck,
  type ObservabilityDeckProps,
} from './ObservabilityDeck.tsx';

export {
  BAND_STATUS,
  MAX_NOTICE_ROWS,
  PRESSURE_STATUS,
  SHED_ACTION_LABELS,
  resourceHealthVM,
  type PressureVM,
  type ResourceHealthVM,
  type SessionFootprintRow,
  type ShedNoticeRow,
} from './resourceHealth.ts';

export {
  RESOURCE_HEALTH_LABEL,
  RESOURCE_TICK_MS,
  ResourceHealthInstrument,
  type ResourceHealthInstrumentProps,
} from './ResourceHealthInstrument.tsx';

export {
  FOCUS_DASHBOARDS_COMMAND_ID,
  observabilityIsland,
  registerObservability,
  type RegisterObservabilityOptions,
} from './register.tsx';
