/**
 * BE-5 source 2 — Claude quota (blueprint §6.1 "Claude quota" row):
 * statusline tee-file ingestion (primary, SI-3's tee) + the rate-limited
 * idle-account OAuth usage poller scaffold (fallback; live client is
 * hard-gated pending-owner).
 */

export {
  createQuotaTeeIngestor,
  parseStatuslinePayload,
  type QuotaTeeIngestor,
  type QuotaTeeIngestorOptions,
  type QuotaTeeIngestorStats,
} from './teeFile.js';

export {
  DEFAULT_OAUTH_BACKOFF,
  OAUTH_USAGE_BETA_HEADER,
  OAUTH_USAGE_ENDPOINT,
  createIdleAccountOauthPoller,
  createLiveOauthUsageClient,
  decodeOauthUsageBody,
  type IdleAccountOauthPoller,
  type IdleAccountOauthPollerOptions,
  type LiveOauthUsageClientOptions,
  type OauthBackoffPolicy,
  type OauthPollerStats,
  type OauthUsageClient,
  type OauthUsageFetchResult,
  type OauthUsageWindow,
} from './oauthPoller.js';
