/**
 * Fake OTLP http/json emitter (plan §3 testkit deliverable: "fake OTLP
 * emitter" — promoted from BE-5's inline builders in
 * core/src/collector/otlp/otlp.spec.ts via ICR-0010, the ICR-0001 path).
 *
 * Builds the OTLP/HTTP JSON batches the Claude Code OTel exporter POSTs to
 * `/v1/logs` (blueprint §6.1 row 1): resource attributes (incl. the
 * harness-stamped `account=<LABEL>` [X2]), scope
 * `com.anthropic.claude_code`, and `api_request` log records carrying the
 * attribution attributes the receiver joins with JSONL token truth.
 *
 * FIXTURE POLICY [X2]: all values synthesized. The IDENTITY-SHAPED values
 * ({@link SYNTHETIC_OTLP_EMAIL} / {@link SYNTHETIC_OTLP_ACCOUNT_UUID}) exist
 * ONLY to prove the receiver drops identity at ingest; they are constructed
 * at RUNTIME from joined fragments so no committed fixture file carries an
 * identity-shaped literal, and they use RFC 6761 `.invalid` / obviously-fake
 * forms. They are deliberately EXEMPT from assertSynthesizedSafeText — being
 * identity-SHAPED is their entire job; every other free-text input to these
 * builders is screened.
 */

import { assertSynthesizedSafeText } from './jsonl.js';

/**
 * Runtime-joined identity-shaped email (never a committed literal). Ingest
 * MUST drop it — assert its absence from every persisted row.
 */
export const SYNTHETIC_OTLP_EMAIL = ['synthetic.person', 'example.invalid'].join('@');

/** Runtime-joined identity-shaped account uuid. Ingest MUST drop it. */
export const SYNTHETIC_OTLP_ACCOUNT_UUID = ['0000', 'synthetic', 'uuid'].join('-');

/** One OTLP KeyValue (string/bool/int/double encodings per the OTLP JSON mapping). */
export function otlpAttr(key: string, value: string | number | boolean): Record<string, unknown> {
  assertSynthesizedSafeText(key);
  if (
    typeof value === 'string' &&
    value !== SYNTHETIC_OTLP_EMAIL &&
    value !== SYNTHETIC_OTLP_ACCOUNT_UUID
  ) {
    assertSynthesizedSafeText(value);
  }
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
}

export interface OtlpLogsBatchOptions {
  /** Resource attributes (the harness stamps `account=<LABEL>` here). */
  readonly resourceAttrs: readonly Record<string, unknown>[];
  /** Log records (see {@link otlpApiRequestRecord}). */
  readonly records: readonly Record<string, unknown>[];
  /** Instrumentation scope name. Default `com.anthropic.claude_code`. */
  readonly scopeName?: string;
}

/** One `/v1/logs` POST body: resourceLogs → scopeLogs → logRecords. */
export function otlpLogsBatch(options: OtlpLogsBatchOptions): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: { attributes: options.resourceAttrs },
        scopeLogs: [
          {
            scope: { name: options.scopeName ?? 'com.anthropic.claude_code' },
            logRecords: options.records,
          },
        ],
      },
    ],
  };
}

/** Synthetic api_request timestamp (epoch ms) used by the default record. */
export const SYNTHETIC_OTLP_API_REQUEST_TS_MS = 1_767_225_610_000;

/**
 * One `api_request` log record with the full attribution attribute set the
 * receiver maps (session/request ids, model, cost, latency, token counts,
 * skill) PLUS the runtime-built identity attributes (`user.email`,
 * `user.account_uuid`) that ingest MUST drop [X2] — included by default so
 * every consumer batch doubles as an identity-drop probe. `overrides` appends
 * additional attributes (string/number/boolean), screened.
 */
export function otlpApiRequestRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timeUnixNano: String(SYNTHETIC_OTLP_API_REQUEST_TS_MS * 1e6),
    body: { stringValue: 'api_request' },
    attributes: [
      otlpAttr('event.name', 'api_request'),
      otlpAttr('session.id', 'synth-native-1'),
      otlpAttr('request_id', 'req_synth_0001'),
      otlpAttr('model', 'claude-synth-4'),
      otlpAttr('cost_usd', 0.42),
      otlpAttr('duration_ms', 1234),
      otlpAttr('input_tokens', 5),
      otlpAttr('output_tokens', 240),
      otlpAttr('skill.name', 'synth-skill'),
      otlpAttr('user.email', SYNTHETIC_OTLP_EMAIL), // MUST be dropped at ingest
      otlpAttr('user.account_uuid', SYNTHETIC_OTLP_ACCOUNT_UUID), // dropped
      ...Object.entries(overrides).map(([key, value]) =>
        otlpAttr(key, value as string | number | boolean),
      ),
    ],
  };
}
