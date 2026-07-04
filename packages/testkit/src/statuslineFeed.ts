/**
 * Fake statusline stdin feed (plan §3 testkit deliverable: "fake statusline
 * stdin feed" — promoted from BE-5's inline builders in
 * core/src/collector/quota/quota.spec.ts via ICR-0010, the ICR-0001 path).
 *
 * Two halves, mirroring how the real feed works on a live host:
 *   - {@link synthesizedStatuslinePayload} — ONE statusline render tick, the
 *     JSON object the Claude CLI writes to the statusline command's stdin
 *     (shape per the SI-3 bats fixture `statusline_fixture()` in
 *     infra/hooks/tests/hooks.bats; observability findings §3, statusline
 *     v1.2.80+: `rate_limits.five_hour`/`seven_day`[/`seven_day_sonnet`],
 *     each `{used_percentage, resets_at}`).
 *   - {@link writeStatuslineTee} — what SI-3's aibender-statusline.sh does
 *     with that stdin: tee it VERBATIM to `<quotaDir>/<LABEL>.json`. The
 *     collector attributes by FILE NAME only [X2] and treats the file mtime
 *     as the capture instant, so the writer can pin `mtimeMs` to make
 *     re-emit/dedupe behavior deterministic.
 *
 * FIXTURE POLICY [X2]: every value synthesized; free-text inputs are screened
 * by {@link assertSynthesizedSafeText}; labels are whatever the test needs
 * (negative suites deliberately write unrecognized names — the collector must
 * skip them, never guess) but are screened against identity shapes too.
 */

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertSynthesizedSafeText } from './jsonl.js';

/** One `rate_limits` window entry as the statusline carries it. */
export interface StatuslineWindowInput {
  readonly usedPercentage: number;
  /** ISO-8601 string or epoch (seconds or ms) — both wire-observed forms. */
  readonly resetsAt: string | number;
}

export interface SynthesizedStatuslinePayloadOptions {
  /** Native session id. Default `synthetic-0001` (the bats fixture value). */
  readonly sessionId?: string;
  /** Model block. Defaults to the bats fixture (`claude-fixture`/`Fixture`). */
  readonly modelId?: string;
  readonly modelDisplayName?: string;
  readonly cwd?: string;
  readonly totalCostUsd?: number;
  readonly contextUsedPercentage?: number;
  /**
   * Window entries. Defaults to the bats fixture pair (5h 41.5% resetting
   * 2026-07-04T12:00:00Z; 7d 12% resetting 2026-07-08T00:00:00Z). Pass an
   * explicit object to control windows — `{}` produces `rate_limits: {}`
   * (the no-window edge the parser must tolerate).
   */
  readonly rateLimits?: {
    readonly fiveHour?: StatuslineWindowInput;
    readonly sevenDay?: StatuslineWindowInput;
    readonly sevenDaySonnet?: StatuslineWindowInput;
  };
}

/** The bats-fixture default windows (kept in sync with hooks.bats). */
const DEFAULT_RATE_LIMITS: NonNullable<SynthesizedStatuslinePayloadOptions['rateLimits']> = {
  fiveHour: { usedPercentage: 41.5, resetsAt: '2026-07-04T12:00:00Z' },
  sevenDay: { usedPercentage: 12, resetsAt: '2026-07-08T00:00:00Z' },
};

/**
 * Generate ONE synthesized statusline stdin payload (JSON string).
 * Deterministic for identical options; identical to the SI-3 bats fixture
 * when called with no options.
 */
export function synthesizedStatuslinePayload(
  options: SynthesizedStatuslinePayloadOptions = {},
): string {
  const sessionId = options.sessionId ?? 'synthetic-0001';
  const modelId = options.modelId ?? 'claude-fixture';
  const modelDisplayName = options.modelDisplayName ?? 'Fixture';
  const cwd = options.cwd ?? '/tmp/fixture';
  for (const text of [sessionId, modelId, modelDisplayName, cwd]) {
    assertSynthesizedSafeText(text);
  }

  const windows = options.rateLimits ?? DEFAULT_RATE_LIMITS;
  const rateLimits: Record<string, { used_percentage: number; resets_at: string | number }> = {};
  for (const [optionKey, wireKey] of [
    ['fiveHour', 'five_hour'],
    ['sevenDay', 'seven_day'],
    ['sevenDaySonnet', 'seven_day_sonnet'],
  ] as const) {
    const entry = windows[optionKey];
    if (entry === undefined) continue;
    if (typeof entry.resetsAt === 'string') assertSynthesizedSafeText(entry.resetsAt);
    rateLimits[wireKey] = {
      used_percentage: entry.usedPercentage,
      resets_at: entry.resetsAt,
    };
  }

  return JSON.stringify({
    session_id: sessionId,
    model: { id: modelId, display_name: modelDisplayName },
    cwd,
    cost: { total_cost_usd: options.totalCostUsd ?? 0.0123 },
    context_window: { used_percentage: options.contextUsedPercentage ?? 33.3 },
    rate_limits: rateLimits,
  });
}

export interface WriteStatuslineTeeOptions {
  /** The quota directory (`$AIBENDER_HOME/quota` on a live host). */
  readonly quotaDir: string;
  /**
   * The tee file's basename WITHOUT `.json` — the collector's attribution
   * axis [X2]. Placeholder labels (MAX_A/MAX_B/ENT) for positive fixtures;
   * negative suites pass unrecognized names on purpose.
   */
  readonly label: string;
  /** Payload; default {@link synthesizedStatuslinePayload}(). */
  readonly payload?: string;
  /**
   * Pin the file mtime (epoch ms). The collector reads mtime as the capture
   * instant, so pinning makes tee re-emit dedupe deterministic.
   */
  readonly mtimeMs?: number;
}

/**
 * Tee one payload to `<quotaDir>/<label>.json` exactly like SI-3's
 * aibender-statusline.sh (verbatim write). Returns the written path.
 */
export function writeStatuslineTee(options: WriteStatuslineTeeOptions): string {
  assertSynthesizedSafeText(options.label);
  if (options.label.includes('/') || options.label.includes('..')) {
    throw new RangeError(`tee label must be a bare file basename, got ${options.label}`);
  }
  const payload = options.payload ?? synthesizedStatuslinePayload();
  mkdirSync(options.quotaDir, { recursive: true });
  const path = join(options.quotaDir, `${options.label}.json`);
  writeFileSync(path, payload);
  if (options.mtimeMs !== undefined) {
    utimesSync(path, new Date(options.mtimeMs), new Date(options.mtimeMs));
  }
  return path;
}
