/**
 * LM Studio inline usage capture (BE-5 source 7; blueprint §6.1 LM Studio
 * row: "Record usage + perf stats per harness-routed call").
 *
 * CONSUMES BE-4's /v1 usage surface (core/src/adapters/lmstudio/client.ts):
 * every successful {@link LmStudioChatCompletion} already carries token
 * usage, wall duration and the TTL that rode the request. This module turns
 * one completion into one events row and offers
 * {@link instrumentLmStudioClient}, a transparent wrapper the composition
 * root puts in front of the adapter so every harness-routed call is captured
 * inline — down/error results pass through UNCHANGED and mint no row
 * (LM-Studio-down is a freshness STATE owned by BE-6, never an error row).
 *
 * raw_ref: each capture is a distinct harness-observed call — a monotonic
 * per-process counter + capture instant keys it. There is no cross-restart
 * replay of this source (nothing is re-read), so process-scoped uniqueness
 * is the correct dedupe posture.
 */

import type { EventsTableStore } from '@aibender/schema';

import type { LmStudioChatCompletion, LmStudioChatRequest, LmStudioChatResult, LmStudioClient } from '../../adapters/lmstudio/client.js';
import { scrubIdentityText } from '../identity.js';

export interface LmStudioUsageCaptureStats {
  readonly captures: number;
  readonly withoutUsage: number;
}

export interface LmStudioUsageCapture {
  /** Ingest one successful completion. Returns true when a row landed. */
  capture(completion: LmStudioChatCompletion): boolean;
  stats(): LmStudioUsageCaptureStats;
}

export interface LmStudioUsageCaptureOptions {
  readonly events: EventsTableStore;
  readonly nowMs?: () => number;
}

export function createLmStudioUsageCapture(
  options: LmStudioUsageCaptureOptions,
): LmStudioUsageCapture {
  const nowMs = options.nowMs ?? Date.now;
  let counter = 0;
  const stats = { captures: 0, withoutUsage: 0 };

  return {
    capture: (completion) => {
      counter += 1;
      const usage = completion.usage;
      if (usage === undefined) stats.withoutUsage += 1;
      const outcome = options.events.insert({
        tsMs: nowMs(),
        backend: 'lmstudio',
        account: 'LOCAL',
        source: 'lmstudio',
        eventType: 'chat_completion',
        rawRef: `lmstudio:${String(nowMs())}:${String(counter)}`,
        model: scrubIdentityText(completion.model),
        provider: 'lmstudio',
        latencyMs: Math.max(0, Math.round(completion.durationMs)),
        ...(usage !== undefined
          ? {
              inputTokens: usage.promptTokens,
              outputTokens: usage.completionTokens,
            }
          : {}),
        // Local inference is $0 marginal — recorded as an explicit zero so
        // the local-offload ratio lead can sum honestly (blueprint §6.3).
        costEstimatedUsd: 0,
      });
      if (outcome.inserted) stats.captures += 1;
      return outcome.inserted;
    },

    stats: () => ({ ...stats }),
  };
}

/**
 * Wrap BE-4's client so every harness-routed /v1 call is captured inline.
 * The wrapper is behavior-transparent: results (ok/down/error) pass through
 * verbatim; only `ok` results mint a row.
 */
export function instrumentLmStudioClient(
  client: LmStudioClient,
  capture: LmStudioUsageCapture,
): LmStudioClient {
  return {
    chat: async (request: LmStudioChatRequest): Promise<LmStudioChatResult> => {
      const result = await client.chat(request);
      if (result.state === 'ok') capture.capture(result.value);
      return result;
    },
  };
}
