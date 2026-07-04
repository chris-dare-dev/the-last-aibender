/**
 * core/src/collector — BE-5 collector sources & normalized events store
 * (plan §4/BE-5; blueprint §6.1 hybrid source matrix → §6.2 events store),
 * plus BE-6's graphfeed/ (context-graph feed — separate ownership).
 *
 * The hybrid matrix, one module per source:
 *   jsonl/     per-account JSONL fs-watch tailer (rotation/truncation-safe;
 *              5m/1h cache-TTL split; usage-data + history.jsonl) — label
 *              from the watch root [X2]
 *   quota/     statusline tee-file ingestion + idle-account OAuth poller
 *              scaffold (live client hard-gated pending-owner)
 *   otlp/      in-process OTLP receiver on 127.0.0.1:4318 (loopback-only,
 *              account=<LABEL> resource attribution, identity attrs dropped)
 *   opencode/  /global/event via BE-4's SSE transport (evt_ dedupe,
 *              after=<seq> gap repair) + guarded opencode.db scrape
 *              reconciling to identical evt_ ids
 *   aws/       Cost Explorer + CloudWatch pollers — interfaces + normalizers
 *              + fakes ONLY (live AWS is SI-4-gated; estimate-only until)
 *   lmstudio/  inline /v1 usage capture consuming BE-4's client surface
 *   hooks/     the hooks-contract.md accepting endpoint (loopback HTTP;
 *              PermissionRequest → ApprovalBroker hook-floor slot)
 *
 * Cross-cutting: ingest.ts (the JSONL-wins-for-tokens / OTel-wins-for-
 * attribution join on request ids), identity.ts (identity dropped/mapped at
 * ingest + the [X2] audit detectors), errors.ts (typed live-call refusals).
 *
 * The store itself is FROZEN-M3 @aibender/schema (openEventsStore —
 * migration 0002; dedupe UNIQUE (backend, raw_ref)); schema changes go
 * through ICR, never from here.
 */

export {
  CollectorError,
  LiveAwsDisabledError,
  LiveOauthDisabledError,
} from './errors.js';

export {
  AUDIT_DETECTORS,
  IDENTITY_ATTRIBUTE_KEYS,
  IDENTITY_DROPPED,
  findIdentityShapes,
  isIdentityAttributeKey,
  scrubIdentityDeep,
  scrubIdentityText,
} from './identity.js';

export { fnv32Hex } from './hash.js';

export {
  apiRequestRawRef,
  createApiRequestJoiner,
  type ApiJoinerStats,
  type ApiRequestJoiner,
  type ApiRequestJoinerOptions,
  type JsonlApiRequestHalf,
  type OtelApiRequestHalf,
} from './ingest.js';

export * from './jsonl/index.js';
export * from './quota/index.js';
export * from './otlp/index.js';
export * from './opencode/index.js';
export * from './aws/index.js';
export * from './lmstudio/index.js';
export * from './hooks/index.js';

// BE-6's context-graph feed (separate ownership; re-exported for the
// composition root's convenience).
export * from './graphfeed/index.js';
