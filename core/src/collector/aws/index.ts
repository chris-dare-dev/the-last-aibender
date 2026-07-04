/**
 * BE-5 source 6 — AWS pollers (blueprint §6.1 "Bedrock real USD" row):
 * Cost Explorer 1–2×/day authoritative backfill into cost_actual_usd +
 * CloudWatch AWS/Bedrock 5–15 min while active. INTERFACES + NORMALIZERS +
 * FAKES ONLY — every live AWS call is owner-gated behind SI-4
 * (LiveAwsDisabledError by default; estimate-only freshness until applied).
 */

export {
  createCostExplorerPoller,
  createLiveCostExplorerClient,
  normalizeCostAndUsage,
  type CostAndUsageResponse,
  type CostExplorerClient,
  type CostExplorerPoller,
  type CostExplorerPollerOptions,
  type CostExplorerPollerStats,
  type LiveCostExplorerClientOptions,
} from './costExplorer.js';

export {
  createCloudWatchPoller,
  createLiveCloudWatchClient,
  normalizeBedrockSample,
  type BedrockMetricSample,
  type CloudWatchBedrockClient,
  type CloudWatchPoller,
  type CloudWatchPollerOptions,
  type CloudWatchPollerStats,
  type LiveCloudWatchClientOptions,
} from './cloudwatch.js';
