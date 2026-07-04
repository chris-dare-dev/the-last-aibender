/**
 * Feature-gated `/api/v0` state reads (BE-4; blueprint §4.3: "state and perf
 * … via native /api/v0 (feature-gated — it is beta)").
 *
 * The gate is a VALUE, not an exception: a disabled reader answers
 * `{ enabled: false }` so consumers (BE-6 freshness, verified-unload) can
 * branch without try/catch. Down remains first-class here too.
 */

import type { LmStudioDownReason } from './health.js';

// ---------------------------------------------------------------------------
// Model state shape (tolerant subset of the beta response)
// ---------------------------------------------------------------------------

export type LmStudioModelResidency = 'loaded' | 'not-loaded';

export interface LmStudioModelState {
  /** Model key as the server reports it (`id` field). */
  readonly key: string;
  readonly state: LmStudioModelResidency;
  readonly quantization?: string;
  readonly maxContextLength?: number;
  /** Context actually allocated when loaded. */
  readonly loadedContextLength?: number;
  readonly type?: string;
  readonly arch?: string;
}

export type ApiV0ModelsResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly ok: true; readonly models: readonly LmStudioModelState[] }
  | { readonly enabled: true; readonly ok: false; readonly down: LmStudioDownReason };

export interface LmStudioApiV0Reader {
  models(): Promise<ApiV0ModelsResult>;
  /** State of one model key; undefined when unknown to the server. */
  modelState(key: string): Promise<
    | { readonly enabled: false }
    | { readonly enabled: true; readonly ok: true; readonly model: LmStudioModelState | undefined }
    | { readonly enabled: true; readonly ok: false; readonly down: LmStudioDownReason }
  >;
}

export interface LmStudioApiV0ReaderOptions {
  readonly baseUrl: string;
  /** The feature gate — /api/v0 is beta; default OFF. */
  readonly enabled: boolean;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function toModelState(value: unknown): LmStudioModelState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const key = record['id'];
  if (typeof key !== 'string' || key.length === 0) return undefined;
  const state: LmStudioModelResidency = record['state'] === 'loaded' ? 'loaded' : 'not-loaded';
  return {
    key,
    state,
    ...(typeof record['quantization'] === 'string'
      ? { quantization: record['quantization'] }
      : {}),
    ...(typeof record['max_context_length'] === 'number'
      ? { maxContextLength: record['max_context_length'] }
      : {}),
    ...(typeof record['loaded_context_length'] === 'number'
      ? { loadedContextLength: record['loaded_context_length'] }
      : {}),
    ...(typeof record['type'] === 'string' ? { type: record['type'] } : {}),
    ...(typeof record['arch'] === 'string' ? { arch: record['arch'] } : {}),
  };
}

export function createLmStudioApiV0Reader(
  options: LmStudioApiV0ReaderOptions,
): LmStudioApiV0Reader {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1_500;

  const fetchModels = async (): Promise<ApiV0ModelsResult> => {
    if (options.enabled !== true) return { enabled: false };
    try {
      const response = await fetchFn(`${options.baseUrl}/api/v0/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { enabled: true, ok: false, down: 'http-error' };
      const body: unknown = await response.json();
      const models: LmStudioModelState[] = [];
      if (typeof body === 'object' && body !== null) {
        const data = (body as Record<string, unknown>)['data'];
        if (Array.isArray(data)) {
          for (const item of data) {
            const model = toModelState(item);
            if (model !== undefined) models.push(model);
          }
        }
      }
      return { enabled: true, ok: true, models };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const down: LmStudioDownReason =
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
      return { enabled: true, ok: false, down };
    }
  };

  return {
    models: fetchModels,
    modelState: async (key) => {
      const result = await fetchModels();
      if (result.enabled === false) return { enabled: false };
      if (!result.ok) return { enabled: true, ok: false, down: result.down };
      return {
        enabled: true,
        ok: true,
        model: result.models.find((model) => model.key === key),
      };
    },
  };
}
