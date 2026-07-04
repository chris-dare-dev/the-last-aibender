/**
 * Synthesized transcript-tail fixtures (tool_use/tool_result pairing, dangling
 * calls, torn tails per SPIKE-D finding 3, malformed interior lines).
 * Promoted from `core/src/kernel/testing/transcriptFixtures.ts` via ICR-0001
 * (docs/contracts/icr/icr-0001-kernel-test-doubles.md). Consumers: BE-1's
 * transcript-tail validator suites today; BE-5's JSONL tailer suites next.
 *
 * FIXTURE POLICY [X2]: every line is SYNTHESIZED. Plain text turns reuse
 * synthesizedJsonlLine (which screens identity-shaped text);
 * tool_use/tool_result lines are built here from fixed, value-free
 * parts — tool ids are `synthtool-<n>`, uuids are `synthmsg-<n>`, and no
 * caller-provided free text is accepted.
 */

import { synthesizedJsonlLine, type PlaceholderAccount } from './jsonl.js';

/** Fixed synthetic epoch — matches testkit's determinism convention. */
const SYNTHETIC_EPOCH_MS = Date.UTC(2026, 0, 1);

export type SynthesizedTranscriptStep =
  /** A plain user text turn. */
  | { readonly kind: 'user' }
  /** A plain assistant text turn. */
  | { readonly kind: 'assistant' }
  /**
   * An assistant tool_use; `paired: true` appends the matching user
   * tool_result line, `false` leaves the call dangling (the mid-tool-call
   * kill shape the validator must detect).
   */
  | { readonly kind: 'tool-call'; readonly paired: boolean }
  /** A torn partial-write fragment (no trailing newline; SPIKE-D finding 3). */
  | { readonly kind: 'torn' }
  /** A malformed interior line (breaks the coherence chain mid-file). */
  | { readonly kind: 'malformed' };

export interface SynthesizedTranscriptOptions {
  readonly account?: PlaceholderAccount;
  readonly nativeSessionId?: string;
  readonly steps: readonly SynthesizedTranscriptStep[];
}

export interface SynthesizedTranscript {
  /** The JSONL text (torn fragments end the text WITHOUT a newline). */
  readonly jsonl: string;
  /** Message uuids in order, one per emitted message line. */
  readonly uuids: readonly string[];
  /** tool_use ids that were left unpaired, in order. */
  readonly unpairedToolUseIds: readonly string[];
}

function messageLine(args: {
  readonly uuid: string;
  readonly sessionId: string;
  readonly account: PlaceholderAccount;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly content: readonly Record<string, unknown>[];
}): string {
  return JSON.stringify({
    synthesized: true,
    type: args.role,
    uuid: args.uuid,
    sessionId: args.sessionId,
    account: args.account,
    timestamp: new Date(SYNTHETIC_EPOCH_MS + args.seq * 1000).toISOString(),
    message: { role: args.role, content: args.content },
  });
}

/**
 * Build one synthesized transcript. Deterministic for identical options.
 */
export function synthesizedTranscript(
  options: SynthesizedTranscriptOptions,
): SynthesizedTranscript {
  const account = options.account ?? 'MAX_A';
  const sessionId = options.nativeSessionId ?? 'synth-native-session';
  const lines: string[] = [];
  const uuids: string[] = [];
  const unpaired: string[] = [];
  let seq = 0;
  let toolSeq = 0;
  let tornFragment: string | null = null;

  for (const step of options.steps) {
    if (tornFragment !== null) {
      throw new RangeError('a torn step must be the final step of a synthesized transcript');
    }
    switch (step.kind) {
      case 'user':
      case 'assistant': {
        // Reuse the line generator for plain turns; rewrite its uuid into
        // the transcript's deterministic uuid space for anchor assertions.
        const raw = JSON.parse(
          synthesizedJsonlLine({ account, sessionId, role: step.kind, seq }),
        ) as Record<string, unknown>;
        const uuid = `synthmsg-${seq}`;
        raw['uuid'] = uuid;
        lines.push(JSON.stringify(raw));
        uuids.push(uuid);
        seq += 1;
        break;
      }
      case 'tool-call': {
        const toolUseId = `synthtool-${toolSeq}`;
        toolSeq += 1;
        const callUuid = `synthmsg-${seq}`;
        lines.push(
          messageLine({
            uuid: callUuid,
            sessionId,
            account,
            seq,
            role: 'assistant',
            content: [
              { type: 'text', text: `synthesized tool call ${toolUseId}` },
              { type: 'tool_use', id: toolUseId, name: 'SynthTool', input: {} },
            ],
          }),
        );
        uuids.push(callUuid);
        seq += 1;
        if (step.paired) {
          const resultUuid = `synthmsg-${seq}`;
          lines.push(
            messageLine({
              uuid: resultUuid,
              sessionId,
              account,
              seq,
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: toolUseId, content: 'synthesized ok' },
              ],
            }),
          );
          uuids.push(resultUuid);
          seq += 1;
        } else {
          unpaired.push(toolUseId);
        }
        break;
      }
      case 'torn':
        // A partial JSON fragment, as a SIGKILL mid-append leaves it.
        tornFragment = `{"synthesized":true,"type":"assistant","uuid":"synthmsg-${seq}","mess`;
        break;
      case 'malformed':
        lines.push('%% synthesized malformed interior line %%');
        break;
    }
  }

  const jsonl =
    lines.map((line) => `${line}\n`).join('') + (tornFragment !== null ? tornFragment : '');

  return { jsonl, uuids, unpairedToolUseIds: unpaired };
}
