/**
 * Supervised `opencode serve` child (BE-4; blueprint §4.2; plan §4/BE-4).
 *
 * Hard properties:
 *   1. 127.0.0.1 ONLY, on a RANDOM per-boot port. Verified live (2026-07-04,
 *      opencode v1.17.13): `--port 0` falls back to the DEFAULT port 4096 —
 *      it does NOT ask the OS for an ephemeral port — so the supervisor picks
 *      a free ephemeral port itself and passes it explicitly, then confirms
 *      it against the child's `opencode server listening on http://…` line.
 *   2. Per-boot random `OPENCODE_SERVER_PASSWORD` (32 bytes base64url), held
 *      in closures only: the returned handle exposes `authHeader()`, never a
 *      password field — `JSON.stringify(handle)` contains no secret (tested).
 *   3. Bedrock env is fetched via the injectable {@link SecretFetcher} AT
 *      SPAWN TIME and handed straight to the spawn call; the supervisor keeps
 *      no reference. Values never serialized to disk (fs-audit test).
 *   4. LIVE-SPAWN OPT-IN: constructing without `liveServeOptIn: true` throws
 *      (typed LiveServeDisabledError) — mirrors the kernel's SdkQueryRunner
 *      gate. Tests inject a fake {@link SpawnServeFn}.
 *   5. Process matching is argv-`serve` based (see argv.ts), NEVER by name;
 *      the supervisor itself only ever signals its own child handle.
 *
 * Restart-on-crash policy deliberately lives OUTSIDE this module (BE-9 M6
 * supervision hardening); the handle exposes `exited` so a supervisor loop
 * can be layered on without changing this seam.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

import {
  AdapterError,
  LiveServeDisabledError,
  ServeExitedError,
  ServeStartTimeoutError,
} from '../errors.js';
import { newServePassword, serveBasicAuthHeader } from './password.js';
import { buildBedrockEnv, type BedrockEnvSpec, type SecretFetcher } from './secrets.js';

// ---------------------------------------------------------------------------
// Spawn seam
// ---------------------------------------------------------------------------

export interface ServeExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** The child surface the supervisor needs — real spawn or test fake. */
export interface ServeChild {
  readonly pid: number | undefined;
  /** Merged stdout+stderr, line-oriented. Single consumer: the supervisor. */
  lines(): AsyncIterable<string>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  readonly exited: Promise<ServeExit>;
}

export interface SpawnServeCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** COMPLETE child environment — replaces, never merges over process.env. */
  readonly env: Readonly<Record<string, string>>;
}

export type SpawnServeFn = (command: SpawnServeCommand) => ServeChild;

/** The real spawn: node:child_process with a fully-replaced environment. */
export function realSpawnServe(command: SpawnServeCommand): ServeChild {
  const child = nodeSpawn(command.executable, [...command.args], {
    env: { ...command.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<ServeExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return {
    pid: child.pid,
    lines: async function* (): AsyncGenerator<string> {
      const out = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const err = createInterface({ input: child.stderr, crlfDelay: Infinity });
      // Merge both line streams through one queue.
      const queue: string[] = [];
      let notify: (() => void) | undefined;
      let openStreams = 2;
      const push = (line: string): void => {
        queue.push(line);
        notify?.();
      };
      const done = (): void => {
        openStreams -= 1;
        notify?.();
      };
      out.on('line', push).on('close', done);
      err.on('line', push).on('close', done);
      for (;;) {
        const line = queue.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (openStreams === 0) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    },
    kill: (signal) => {
      child.kill(signal);
    },
    exited,
  };
}

// ---------------------------------------------------------------------------
// Ready-line parsing (format verified live against v1.17.13)
// ---------------------------------------------------------------------------

const LISTENING_LINE_RE = /listening on (http:\/\/127\.0\.0\.1:(\d{1,5}))\/?\s*$/;

/** Parse the serve child's ready line; undefined when the line is not it. */
export function parseListeningLine(line: string): { url: string; port: number } | undefined {
  const match = LISTENING_LINE_RE.exec(line);
  if (match === null) return undefined;
  const url = match[1];
  const portText = match[2];
  if (url === undefined || portText === undefined) return undefined;
  return { url, port: Number(portText) };
}

// ---------------------------------------------------------------------------
// Free-port picking (127.0.0.1 ephemeral)
// ---------------------------------------------------------------------------

/** Ask the OS for a currently-free ephemeral port on 127.0.0.1. */
export async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface ServeHealth {
  readonly healthy: boolean;
  readonly version?: string;
}

export interface OpencodeServeHandle {
  readonly url: string;
  readonly port: number;
  readonly pid: number | undefined;
  /** HTTP Basic header for this boot — the password itself stays in closure. */
  authHeader(): string;
  /** GET /global/health with a short timeout; unreachable → healthy:false. */
  health(): Promise<ServeHealth>;
  /** Resolves when the child exits (crash surface for a supervisor loop). */
  readonly exited: Promise<ServeExit>;
  /** SIGTERM → grace → SIGKILL. Idempotent. */
  stop(): Promise<ServeExit>;
}

export interface OpencodeServeSupervisorOptions {
  /**
   * MUST be `true`. No code path may construct a serve supervisor by
   * accident — composition roots set it only from explicit operator config
   * (T3 for real runs; tests set it alongside an injected spawnFn).
   */
  readonly liveServeOptIn: boolean;
  /** Absolute path to the opencode binary (live mode). Default: `opencode`. */
  readonly executablePath?: string;
  /** Injectable spawn (tests). Omitted → the real child_process spawn. */
  readonly spawnFn?: SpawnServeFn;
  /**
   * Base env snapshot for the child (PATH/HOME for live runs). The child env
   * is built FROM SCRATCH off this — never process.env implicitly.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Bedrock env spec + fetcher; both optional (non-Bedrock serve is legal). */
  readonly bedrock?: BedrockEnvSpec;
  readonly secretFetcher?: SecretFetcher;
  /** Secret-value tap for the shared line scrubber [X2] (password included). */
  readonly onSecretValue?: (value: string) => void;
  /** Scrubbed child output tap (composition root logs through the scrubber). */
  readonly onLine?: (line: string) => void;
  readonly fetchFn?: typeof fetch;
  readonly portPicker?: () => Promise<number>;
  /** Ready-line deadline, ms. Default 15000. */
  readonly readyTimeoutMs?: number;
  /** SIGTERM→SIGKILL grace, ms. Default 3000. */
  readonly killGraceMs?: number;
}

export interface OpencodeServeSupervisor {
  start(): Promise<OpencodeServeHandle>;
}

export function createOpencodeServeSupervisor(
  options: OpencodeServeSupervisorOptions,
): OpencodeServeSupervisor {
  if (options.liveServeOptIn !== true) throw new LiveServeDisabledError();

  const spawnFn = options.spawnFn ?? realSpawnServe;
  const fetchFn = options.fetchFn ?? fetch;
  const portPicker = options.portPicker ?? pickFreePort;
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const killGraceMs = options.killGraceMs ?? 3_000;

  return {
    start: async (): Promise<OpencodeServeHandle> => {
      const password = newServePassword();
      options.onSecretValue?.(password);

      // Child env: explicit base (undefined values dropped) + password +
      // spawn-time-fetched Bedrock block. Assembled, handed to spawn, and
      // not retained anywhere on the supervisor or handle.
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.baseEnv ?? {})) {
        if (value !== undefined) env[key] = value;
      }
      env['OPENCODE_SERVER_PASSWORD'] = password;
      if (options.bedrock !== undefined) {
        if (
          options.secretFetcher === undefined &&
          options.bedrock.keychainEnv !== undefined &&
          options.bedrock.keychainEnv.length > 0
        ) {
          throw new AdapterError(
            'bad-request',
            'bedrock keychainEnv requires a SecretFetcher — none was wired',
          );
        }
        const bedrockEnv = await buildBedrockEnv({
          spec: options.bedrock,
          // Reached only for plain-env specs (the guard above): the fallback
          // fetcher can never be invoked.
          secretFetcher: options.secretFetcher ?? { fetch: async () => '' },
          ...(options.onSecretValue !== undefined
            ? { onSecretValue: options.onSecretValue }
            : {}),
        });
        Object.assign(env, bedrockEnv);
      }

      const port = await portPicker();
      const child = spawnFn({
        executable: options.executablePath ?? 'opencode',
        args: ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
        env: Object.freeze(env),
      });

      // --- wait for the ready line, racing child exit and the deadline -----
      const lineIterator = child.lines()[Symbol.asyncIterator]();
      const ready = await new Promise<{ url: string; port: number }>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new ServeStartTimeoutError(readyTimeoutMs));
        }, readyTimeoutMs);
        void child.exited.then((exit) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new ServeExitedError(`code=${String(exit.code)} signal=${String(exit.signal)}`));
        });
        void (async () => {
          for (;;) {
            const next = await lineIterator.next();
            if (settled) return;
            if (next.done === true) return; // exit handler settles
            options.onLine?.(next.value);
            const parsed = parseListeningLine(next.value);
            if (parsed !== undefined) {
              settled = true;
              clearTimeout(timer);
              resolve(parsed);
              return;
            }
          }
        })().catch((error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });

      if (ready.port !== port) {
        // The child bound somewhere we did not ask for — refuse to trust it.
        child.kill('SIGKILL');
        throw new ServeExitedError(
          `serve reported port ${String(ready.port)} but ${String(port)} was requested`,
        );
      }

      // Keep draining child output so the pipe never backpressures the child.
      void (async () => {
        for (;;) {
          const next = await lineIterator.next();
          if (next.done === true) return;
          options.onLine?.(next.value);
        }
      })().catch(() => undefined);

      const url = ready.url;
      let stopping: Promise<ServeExit> | undefined;

      return {
        url,
        port,
        pid: child.pid,
        authHeader: () => serveBasicAuthHeader(password),
        health: async (): Promise<ServeHealth> => {
          try {
            const response = await fetchFn(`${url}/global/health`, {
              headers: { authorization: serveBasicAuthHeader(password) },
              signal: AbortSignal.timeout(2_000),
            });
            if (!response.ok) return { healthy: false };
            const body: unknown = await response.json();
            if (typeof body === 'object' && body !== null) {
              const record = body as Record<string, unknown>;
              return {
                healthy: record['healthy'] === true,
                ...(typeof record['version'] === 'string'
                  ? { version: record['version'] }
                  : {}),
              };
            }
            return { healthy: false };
          } catch {
            return { healthy: false };
          }
        },
        exited: child.exited,
        stop: (): Promise<ServeExit> => {
          stopping ??= (async () => {
            child.kill('SIGTERM');
            const graceful = await Promise.race([
              child.exited,
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), killGraceMs)),
            ]);
            if (graceful !== undefined) return graceful;
            child.kill('SIGKILL');
            return await child.exited;
          })();
          return stopping;
        },
      };
    },
  };
}
