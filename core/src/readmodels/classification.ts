/**
 * Correction-intent classification for the skill leaderboard (BE-6; blueprint
 * §6.3 "correction-intent classification is a local-model job", plan §4/BE-6
 * item 4). Dispatched THROUGH BE-4's LM Studio adapter
 * (core/src/adapters/lmstudio/client.ts) — the qwen-produces/Claude-reviews
 * split of the program: classification volume rides the local tier, never a
 * paid model. NO cost-incurring inference anywhere near this queue.
 *
 * DOWN-AS-STATE (blueprint §4.3): the adapter answers `{state:'down'}` when
 * LM Studio is unreachable — the queue simply STOPS DRAINING and reports
 * `lmstudio-down`; jobs stay queued and drain when the model is back up.
 * Nothing here ever throws for a down server, and the leaderboard's
 * `correctionRatePct` stays ABSENT (not zero) until jobs classify — the
 * snapshot's lmstudio freshness entry says why.
 *
 * [X2]: job text is held IN MEMORY ONLY for the duration of the local call —
 * it is never persisted, never published, and never appears in any read
 * model. Only the aggregate per-skill rate leaves this module.
 */

import type { LmStudioChatResult, LmStudioClient } from '../adapters/lmstudio/index.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CorrectionJob {
  /** The skill whose outcome the follow-up text refers to. */
  readonly skillName: string;
  /** The user's follow-up text to classify (memory-only, see module doc). */
  readonly text: string;
}

export interface CorrectionTally {
  /** Jobs that produced a verdict. */
  readonly classified: number;
  /** Verdicts that read as correction-intent. */
  readonly corrections: number;
}

export type DrainOutcome =
  /** Queue emptied (or nothing was queued). */
  | { readonly state: 'drained'; readonly classified: number; readonly dropped: number }
  /** LM Studio answered down — remaining jobs stay queued (down-as-state). */
  | {
      readonly state: 'lmstudio-down';
      readonly classified: number;
      readonly dropped: number;
      readonly remaining: number;
    };

export interface CorrectionIntentClassifier {
  enqueue(job: CorrectionJob): void;
  pendingCount(): number;
  /**
   * Classify queued jobs through the local model until the queue is empty or
   * LM Studio reports down. Serial on purpose — one small local job at a
   * time, never a burst that competes with account sessions ([X1] sacrifice
   * order: local model yields first).
   */
  drain(): Promise<DrainOutcome>;
  /** Aggregate tallies per skill (only aggregates ever leave this module). */
  tallies(): ReadonlyMap<string, CorrectionTally>;
  /** skillName → correction percent; undefined until something classified. */
  correctionRatePctBySkill(): ReadonlyMap<string, number>;
}

export interface CorrectionClassifierOptions {
  /** BE-4's LM Studio `/v1` client — the ONLY inference path used. */
  readonly client: LmStudioClient;
  /** Local model key to route to. */
  readonly model: string;
  /** Per-job hard-error attempts before the job is dropped. Default 2. */
  readonly maxAttemptsPerJob?: number;
}

// ---------------------------------------------------------------------------
// Prompt + verdict parsing
// ---------------------------------------------------------------------------

/**
 * Deterministic tiny-completion prompt: the model answers one word. Kept
 * boring on purpose — a 7B-class local model classifies reliably with a
 * closed answer set and temperature 0.
 */
export const CLASSIFIER_SYSTEM_PROMPT =
  'You label a user follow-up message about an AI coding assistant result. ' +
  'Answer with exactly one word: CORRECTION if the message asks to fix, redo, ' +
  'undo, or complains the result was wrong; OTHERWISE answer ACCEPT.';

/** A verdict is a correction iff the completion leads with CORRECTION. */
export function parseVerdict(content: string): 'correction' | 'accept' {
  return /^\s*correction\b/i.test(content) ? 'correction' : 'accept';
}

// ---------------------------------------------------------------------------
// createCorrectionIntentClassifier
// ---------------------------------------------------------------------------

interface QueuedJob extends CorrectionJob {
  attempts: number;
}

export function createCorrectionIntentClassifier(
  options: CorrectionClassifierOptions,
): CorrectionIntentClassifier {
  const maxAttempts = options.maxAttemptsPerJob ?? 2;
  const queue: QueuedJob[] = [];
  const tallies = new Map<string, { classified: number; corrections: number }>();
  let draining = false;

  const tallyFor = (skillName: string): { classified: number; corrections: number } => {
    const existing = tallies.get(skillName);
    if (existing !== undefined) return existing;
    const created = { classified: 0, corrections: 0 };
    tallies.set(skillName, created);
    return created;
  };

  const classifyOne = async (job: QueuedJob): Promise<LmStudioChatResult> =>
    options.client.chat({
      model: options.model,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: job.text },
      ],
      maxTokens: 4,
      temperature: 0,
    });

  return {
    enqueue: (job) => {
      queue.push({ ...job, attempts: 0 });
    },

    pendingCount: () => queue.length,

    drain: async () => {
      if (draining) return { state: 'drained', classified: 0, dropped: 0 };
      draining = true;
      let classified = 0;
      let dropped = 0;
      try {
        while (queue.length > 0) {
          const job = queue[0];
          if (job === undefined) break;
          const result = await classifyOne(job);
          if (result.state === 'down') {
            // Down is a STATE: keep the job queued, stop draining.
            return { state: 'lmstudio-down', classified, dropped, remaining: queue.length };
          }
          if (result.state === 'error') {
            job.attempts += 1;
            if (job.attempts >= maxAttempts) {
              queue.shift();
              dropped += 1; // never blocks the queue; the rate stays honest
            }
            continue;
          }
          queue.shift();
          const tally = tallyFor(job.skillName);
          tally.classified += 1;
          if (parseVerdict(result.value.content) === 'correction') tally.corrections += 1;
          classified += 1;
        }
        return { state: 'drained', classified, dropped };
      } finally {
        draining = false;
      }
    },

    tallies: () =>
      new Map([...tallies.entries()].map(([skill, tally]) => [skill, { ...tally }])),

    correctionRatePctBySkill: () => {
      const rates = new Map<string, number>();
      for (const [skill, tally] of tallies) {
        if (tally.classified > 0) {
          rates.set(skill, (tally.corrections / tally.classified) * 100);
        }
      }
      return rates;
    },
  };
}
