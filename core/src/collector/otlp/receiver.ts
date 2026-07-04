/**
 * In-process OTLP receiver on 127.0.0.1:4318 (BE-5 source 3; blueprint §6.1
 * row 1: "OTLP → in-process receiver on 127.0.0.1:4318").
 *
 * Surface:
 *   - POST /v1/logs     application/json → log records ingested (mapper.ts):
 *                       api_request → join half, everything else → row.
 *   - POST /v1/metrics  ACKED (200) and counted, NOT ingested: the OTel
 *                       `api_request` LOG event already carries all four
 *                       token counts + cost per request (findings §1), so
 *                       ingesting delta-temporality metric points would
 *                       double-count. Dashboards read the events store.
 *   - POST /v1/traces   acked + counted (beta surface; not a §6.3 lead).
 *   - application/x-protobuf → 415 counted: SI-3's env block pins
 *     `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`; a protobuf body means a
 *     misconfigured account dir and must be VISIBLE (counted) without ever
 *     crashing ingestion.
 *
 * LOOPBACK-ONLY: the bind host is hardcoded 127.0.0.1 (asserted by test).
 * PORT-IN-USE is handled gracefully: `start` resolves with
 * `state: 'port-in-use'` (a freshness/composition concern, not a crash) —
 * blueprint §6.1 receiver row, task brief "graceful port-in-use handling".
 *
 * [X2]: account attribution comes ONLY from the `account=<LABEL>` resource
 * attribute the harness itself stamps (SI-3); batches without a valid label
 * are dropped and counted. Identity-bearing attribute keys are dropped at
 * ingest (mapper.ts / identity.ts).
 */

import { createServer, type Server } from 'node:http';

import type { EventsTableStore } from '@aibender/schema';

import type { ApiRequestJoiner } from '../ingest.js';
import { accountFromResource, mapOtlpLogRecord } from './mapper.js';

export const OTLP_RECEIVER_HOST = '127.0.0.1';
export const DEFAULT_OTLP_PORT = 4318;

export interface OtlpReceiverStats {
  readonly logBatches: number;
  readonly logRecordsIngested: number;
  readonly logRecordsSkipped: number;
  /** Batches dropped for a missing/invalid `account` resource attribute. */
  readonly batchesDroppedNoLabel: number;
  readonly metricsAcked: number;
  readonly tracesAcked: number;
  readonly protobufRejected: number;
  readonly malformedBodies: number;
}

export interface OtlpReceiver {
  readonly state: 'listening' | 'port-in-use';
  /** Bound port (0 until listening). */
  readonly port: number;
  readonly url: string;
  stats(): OtlpReceiverStats;
  close(): Promise<void>;
}

export interface OtlpReceiverOptions {
  readonly events: EventsTableStore;
  readonly joiner: ApiRequestJoiner;
  /** Default 4318. Tests pass 0 for an ephemeral port. */
  readonly port?: number;
  /** Injectable clock for records without timestamps. */
  readonly nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function startOtlpReceiver(options: OtlpReceiverOptions): Promise<OtlpReceiver> {
  const nowMs = options.nowMs ?? Date.now;
  const stats = {
    logBatches: 0,
    logRecordsIngested: 0,
    logRecordsSkipped: 0,
    batchesDroppedNoLabel: 0,
    metricsAcked: 0,
    tracesAcked: 0,
    protobufRejected: 0,
    malformedBodies: 0,
  };

  const ingestLogs = (body: unknown): void => {
    if (!isRecord(body)) {
      stats.malformedBodies += 1;
      return;
    }
    const resourceLogs = body['resourceLogs'];
    if (!Array.isArray(resourceLogs)) {
      stats.malformedBodies += 1;
      return;
    }
    stats.logBatches += 1;
    for (const resourceEntry of resourceLogs) {
      if (!isRecord(resourceEntry)) continue;
      const account = accountFromResource(resourceEntry['resource']);
      if (account === undefined) {
        // No harness-stamped label → dropped, never guessed [X2].
        stats.batchesDroppedNoLabel += 1;
        continue;
      }
      const scopeLogs = resourceEntry['scopeLogs'];
      if (!Array.isArray(scopeLogs)) continue;
      for (const scopeEntry of scopeLogs) {
        if (!isRecord(scopeEntry)) continue;
        const logRecords = scopeEntry['logRecords'];
        if (!Array.isArray(logRecords)) continue;
        for (const logRecord of logRecords) {
          const mapped = mapOtlpLogRecord(account, logRecord, nowMs());
          if (mapped.kind === 'skipped') {
            stats.logRecordsSkipped += 1;
          } else if (mapped.kind === 'api-request-half') {
            options.joiner.offerOtel(mapped.half);
            stats.logRecordsIngested += 1;
          } else {
            options.events.insert(mapped.row);
            stats.logRecordsIngested += 1;
          }
        }
      }
    }
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      const contentType = String(req.headers['content-type'] ?? '');

      if (method !== 'POST' || !url.startsWith('/v1/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (contentType.includes('protobuf')) {
        // SI-3 pins http/json; a protobuf exporter is a visible misconfig.
        stats.protobufRejected += 1;
        res.writeHead(415, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'this receiver accepts application/json (http/json)' }));
        return;
      }

      if (url === '/v1/metrics') {
        stats.metricsAcked += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url === '/v1/traces') {
        stats.tracesAcked += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url !== '/v1/logs') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        stats.malformedBodies += 1;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unparseable OTLP JSON body' }));
        return;
      }
      try {
        ingestLogs(body);
      } catch {
        // Ingest failures must never propagate backpressure to the CLI.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  const port = options.port ?? DEFAULT_OTLP_PORT;
  const outcome = await new Promise<'listening' | 'port-in-use'>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE' ? 'port-in-use' : 'port-in-use');
    });
    server.listen(port, OTLP_RECEIVER_HOST, () => resolve('listening'));
  });

  if (outcome === 'port-in-use') {
    return {
      state: 'port-in-use',
      port: 0,
      url: '',
      stats: () => ({ ...stats }),
      close: async () => {
        /* nothing bound */
      },
    };
  }

  const address = server.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : port;

  return {
    state: 'listening',
    port: boundPort,
    url: `http://${OTLP_RECEIVER_HOST}:${String(boundPort)}`,
    stats: () => ({ ...stats }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
