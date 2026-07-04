/**
 * LM Studio health probe (BE-4; blueprint §4.3: "'Down' is a FIRST-CLASS
 * STATE (the server was down during every probe): health-check with a short
 * timeout, render a dimmed 'NO SIGNAL' instrument (not an error toast)").
 *
 * The probe NEVER throws for a down server — down is a value, not an
 * exception. BE-6's freshness state machine consumes this verbatim.
 */

export type LmStudioDownReason = 'unreachable' | 'timeout' | 'http-error';

export type LmStudioHealth =
  | { readonly state: 'up'; readonly modelCount: number }
  | { readonly state: 'down'; readonly reason: LmStudioDownReason };

export interface LmStudioHealthProbeOptions {
  /** Base URL — 127.0.0.1 by construction ([X3]); e.g. http://127.0.0.1:1234 */
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  /** SHORT by design — the down path must never hang a caller. Default 750. */
  readonly timeoutMs?: number;
}

export interface LmStudioHealthProbe {
  check(): Promise<LmStudioHealth>;
}

export const DEFAULT_HEALTH_TIMEOUT_MS = 750;

/** Probe via `GET /v1/models` — present on every LM Studio server version. */
export function createLmStudioHealthProbe(
  options: LmStudioHealthProbeOptions,
): LmStudioHealthProbe {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  return {
    check: async (): Promise<LmStudioHealth> => {
      try {
        const response = await fetchFn(`${options.baseUrl}/v1/models`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { state: 'down', reason: 'http-error' };
        const body: unknown = await response.json();
        let modelCount = 0;
        if (typeof body === 'object' && body !== null) {
          const data = (body as Record<string, unknown>)['data'];
          if (Array.isArray(data)) modelCount = data.length;
        }
        return { state: 'up', modelCount };
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          return { state: 'down', reason: 'timeout' };
        }
        return { state: 'down', reason: 'unreachable' };
      }
    },
  };
}
