/**
 * `lms` CLI lifecycle verbs behind an interface (BE-4; blueprint §4.3
 * "lifecycle via the `lms` CLI under a LaunchAgent"), plus VERIFIED unload.
 *
 * The interface is the seam: the composition root may wire the CLI-backed
 * implementation (live opt-in gated — same class as liveSpawnOptIn) or any
 * future native-API implementation; tests wire fakes. The LaunchAgent that
 * supervises `lms server start` itself is SI territory (SI-5) — this module
 * only issues the verbs.
 *
 * VERIFIED UNLOAD: LM Studio has known auto-evict/TTL-bypass bugs
 * (lmstudio-bug-tracker #2051, #634) — an unload is treated as complete only
 * once `/api/v0/models` reports the model `not-loaded`. When /api/v0 is
 * feature-gated OFF the verification honestly reports `api-v0-gated` rather
 * than assuming success.
 */

import { execFile } from 'node:child_process';

import { LiveLmsCliDisabledError } from '../errors.js';
import type { LmStudioApiV0Reader } from './apiV0.js';

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface LmsVerbResult {
  readonly ok: boolean;
  /** Trimmed CLI output (diagnostics only — no parsing promises). */
  readonly output: string;
}

export interface LmsLifecycle {
  serverStart(): Promise<LmsVerbResult>;
  serverStop(): Promise<LmsVerbResult>;
  /** JIT-load with an explicit TTL (residency policy supplies the seconds). */
  load(modelKey: string, options: { readonly ttlSeconds: number }): Promise<LmsVerbResult>;
  unload(modelKey: string): Promise<LmsVerbResult>;
  ps(): Promise<LmsVerbResult>;
}

// ---------------------------------------------------------------------------
// CLI-backed implementation (live opt-in gated)
// ---------------------------------------------------------------------------

export type LmsExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultExec: LmsExecFn = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ stdout, stderr, code });
    });
  });

export interface LmsCliLifecycleOptions {
  /**
   * MUST be `true`. No code path shells `lms` by accident; composition roots
   * set it only from explicit operator config (T3 for real runs).
   */
  readonly liveCliOptIn: boolean;
  /** Injectable exec (unit tests verify argv without shelling). */
  readonly execFn?: LmsExecFn;
  /** Binary path/name. Default `lms`. */
  readonly lmsPath?: string;
}

export function createLmsCliLifecycle(options: LmsCliLifecycleOptions): LmsLifecycle {
  if (options.liveCliOptIn !== true) throw new LiveLmsCliDisabledError();
  const exec = options.execFn ?? defaultExec;
  const lms = options.lmsPath ?? 'lms';

  const run = async (args: readonly string[]): Promise<LmsVerbResult> => {
    const { stdout, stderr, code } = await exec(lms, args);
    return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
  };

  return {
    serverStart: () => run(['server', 'start']),
    serverStop: () => run(['server', 'stop']),
    load: (modelKey, { ttlSeconds }) =>
      run(['load', modelKey, '--ttl', String(ttlSeconds), '--yes']),
    unload: (modelKey) => run(['unload', modelKey]),
    ps: () => run(['ps', '--json']),
  };
}

// ---------------------------------------------------------------------------
// Verified unload
// ---------------------------------------------------------------------------

export type UnloadVerification =
  | { readonly verified: true; readonly attempts: number }
  | {
      readonly verified: false;
      readonly reason: 'still-loaded' | 'api-v0-gated' | 'down';
      readonly attempts: number;
    };

export interface VerifyUnloadOptions {
  readonly attempts?: number;
  readonly intervalMs?: number;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `/api/v0/models` until the model reports `not-loaded` (or is gone).
 * Never assumes: gated API or a down server yield honest non-verification.
 */
export async function verifyUnload(
  modelKey: string,
  reader: LmStudioApiV0Reader,
  options: VerifyUnloadOptions = {},
): Promise<UnloadVerification> {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 200;
  const sleepFn = options.sleepFn ?? defaultSleep;

  let made = 0;
  for (let i = 0; i < attempts; i += 1) {
    made += 1;
    const result = await reader.modelState(modelKey);
    if (result.enabled === false) return { verified: false, reason: 'api-v0-gated', attempts: made };
    if (!result.ok) return { verified: false, reason: 'down', attempts: made };
    if (result.model === undefined || result.model.state === 'not-loaded') {
      return { verified: true, attempts: made };
    }
    if (i < attempts - 1) await sleepFn(intervalMs);
  }
  return { verified: false, reason: 'still-loaded', attempts: made };
}
