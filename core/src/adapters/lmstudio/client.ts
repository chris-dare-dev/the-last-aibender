/**
 * LM Studio `/v1` inference routing (BE-4; blueprint §4.3: "Inference via the
 * OpenAI-compatible /v1"; JIT semantics via the per-request `ttl` field —
 * lmstudio.ai docs "Idle TTL and Auto-Evict").
 *
 * Contract:
 *   - Every request carries a TTL: the caller's explicit `ttlSeconds`, else
 *     the residency policy's pressure-derived TTL (1800 s nominal / 900 s
 *     amber — residency.ts). The TTL rides the request payload, so a JIT
 *     load and a TTL refresh are the same operation.
 *   - DOWN IS A STATE, never an exception: network failure or timeout
 *     mid-request answers `{ state:'down' }` (plan §9.2 edge: "LM Studio
 *     down mid-request → down-state not error").
 *   - Inline usage capture: token usage + wall duration returned with every
 *     completion (BE-5's "LM Studio inline usage capture" feed).
 *   - `onModelUsed` fires on every successful routing so the composition
 *     root can register/touch the residency ledger with catalog data.
 */

import type { LmStudioDownReason } from './health.js';
import { ttlForPressure, type PressureState } from './residency.js';

// ---------------------------------------------------------------------------
// Request/result shapes
// ---------------------------------------------------------------------------

export interface LmStudioChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LmStudioChatRequest {
  readonly model: string;
  readonly messages: readonly LmStudioChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Explicit TTL override; else derived from pressure via the policy. */
  readonly ttlSeconds?: number;
}

export interface LmStudioUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface LmStudioChatCompletion {
  readonly content: string;
  readonly model: string;
  readonly usage?: LmStudioUsage;
  /** Wall-clock request duration, ms (latency instrumentation). */
  readonly durationMs: number;
  /** TTL that rode the request (observability of the JIT policy). */
  readonly ttlSeconds: number;
}

export type LmStudioChatResult =
  | { readonly state: 'ok'; readonly value: LmStudioChatCompletion }
  | { readonly state: 'down'; readonly reason: LmStudioDownReason }
  | { readonly state: 'error'; readonly status?: number; readonly message: string };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface LmStudioClientOptions {
  /** 127.0.0.1 by construction ([X3]). */
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  /** Whole-request deadline, ms. Default 120 000 (local decode is slow). */
  readonly timeoutMs?: number;
  /** Current memory pressure (BE-9's governor). Default: nominal. */
  readonly pressureFn?: () => PressureState;
  /** Ledger/catalog hook: fired per successful request with the TTL used. */
  readonly onModelUsed?: (modelKey: string, ttlSeconds: number) => void;
}

export interface LmStudioClient {
  chat(request: LmStudioChatRequest): Promise<LmStudioChatResult>;
}

function toUsage(value: unknown): LmStudioUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const prompt = record['prompt_tokens'];
  const completion = record['completion_tokens'];
  const total = record['total_tokens'];
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: typeof total === 'number' ? total : prompt + completion,
  };
}

export function createLmStudioClient(options: LmStudioClientOptions): LmStudioClient {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pressureFn = options.pressureFn ?? ((): PressureState => 'nominal');

  return {
    chat: async (request): Promise<LmStudioChatResult> => {
      const ttlSeconds = request.ttlSeconds ?? ttlForPressure(pressureFn());
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchFn(`${options.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            // LM Studio JIT: per-request TTL (docs: ttl-and-auto-evict).
            ttl: ttlSeconds,
            stream: false,
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const reason: LmStudioDownReason =
          name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
        return { state: 'down', reason };
      }

      if (!response.ok) {
        let message = `lmstudio /v1/chat/completions answered ${String(response.status)}`;
        try {
          const body: unknown = await response.json();
          if (typeof body === 'object' && body !== null) {
            const err = (body as Record<string, unknown>)['error'];
            if (typeof err === 'string') message = err;
            else if (typeof err === 'object' && err !== null) {
              const detail = (err as Record<string, unknown>)['message'];
              if (typeof detail === 'string') message = detail;
            }
          }
        } catch {
          // keep the status-derived message
        }
        return { state: 'error', status: response.status, message };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { state: 'error', message: 'lmstudio answered non-JSON body' };
      }
      if (typeof body !== 'object' || body === null) {
        return { state: 'error', message: 'lmstudio answered a non-object body' };
      }
      const record = body as Record<string, unknown>;
      const choices = record['choices'];
      let content = '';
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as Record<string, unknown> | undefined;
        const message = first?.['message'];
        if (typeof message === 'object' && message !== null) {
          const text = (message as Record<string, unknown>)['content'];
          if (typeof text === 'string') content = text;
        }
      }
      const model = typeof record['model'] === 'string' ? record['model'] : request.model;
      const usage = toUsage(record['usage']);

      options.onModelUsed?.(model, ttlSeconds);
      return {
        state: 'ok',
        value: {
          content,
          model,
          durationMs: Date.now() - startedAt,
          ttlSeconds,
          ...(usage !== undefined ? { usage } : {}),
        },
      };
    },
  };
}
