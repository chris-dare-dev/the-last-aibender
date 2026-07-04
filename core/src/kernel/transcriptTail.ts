/**
 * Transcript-tail validator (BE-1; blueprint §4.1 "before any resume, a
 * transcript-tail validator repairs or forks from the last coherent message").
 *
 * Parses the tail of a Claude Code JSONL transcript and decides whether a
 * plain (un-forked) resume is safe:
 *
 *   - INCOMPLETE TOOL PAIRING: an assistant `tool_use` block with no matching
 *     `tool_result` (the known mid-tool-call kill failure mode) makes the tail
 *     incoherent from that assistant message onward.
 *   - TORN TAIL: a SIGKILL mid-append leaves a partial final JSONL line
 *     (SPIKE-D finding 3). The fragment is skipped for anchoring, but its
 *     presence marks the transcript as needing repair — the harness NEVER
 *     mutates native stores (X4 guardrail), so repair means forking, not
 *     truncating the file.
 *   - MALFORMED INTERIOR line: everything after it is untrusted (SPIKE-D
 *     finding 4's spirit: coherence is chained, a bad record breaks the chain
 *     at that point rather than being skipped over).
 *
 * REPAIR = fork from the last coherent message: the kernel resumes with
 * `forkSession: true` + `resumeSessionAt: <lastCoherentUuid>` so the corrupt
 * tail is left behind in the parent and the child continues from the last
 * message after which no tool_use was pending.
 *
 * Fixtures are SYNTHESIZED (@aibender/testkit synthesizedTranscript, promoted
 * via ICR-0001; testkit policy [X2]) — never copied from real transcripts.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface TranscriptTailVerdict {
  /** True ⇔ a plain un-forked resume is safe. */
  readonly safeToResume: boolean;
  /**
   * Uuid of the last coherent message — the fork/repair anchor: the last
   * parsed message after which zero tool_use blocks were pending. Null when
   * no coherent anchor exists (empty/unusable transcript).
   */
  readonly lastCoherentUuid: string | null;
  /** tool_use ids left unpaired at the end of the parse. */
  readonly unpairedToolUseIds: readonly string[];
  /** The final line was a torn (partial-write) fragment and was skipped. */
  readonly tornTail: boolean;
  /** A non-final line failed to parse; the chain breaks there. */
  readonly malformedInterior: boolean;
  /** Zero parseable transcript lines. */
  readonly empty: boolean;
  readonly parsedLines: number;
}

// ---------------------------------------------------------------------------
// Line model (structural — only the fields the validator needs)
// ---------------------------------------------------------------------------

interface ContentBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly tool_use_id?: unknown;
}

function contentBlocks(line: Record<string, unknown>): readonly ContentBlock[] {
  const message = line['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate transcript-tail JSONL text. Pure; independent of any file system.
 */
export function validateTranscriptTail(jsonl: string): TranscriptTailVerdict {
  const segments = jsonl.split('\n');
  // A trailing newline yields one empty final segment — that is a CLEAN tail.
  // A non-empty final segment that fails to parse is a TORN tail.
  const pending = new Map<string, true>(); // tool_use id → awaiting tool_result
  let lastCoherentUuid: string | null = null;
  let tornTail = false;
  let malformedInterior = false;
  let parsedLines = 0;

  for (const [index, segment] of segments.entries()) {
    const isFinal = index === segments.length - 1;
    const text = segment.trim();
    if (text.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (isFinal) {
        tornTail = true;
      } else {
        malformedInterior = true;
      }
      break; // the chain breaks here either way; later lines are untrusted
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      if (isFinal) tornTail = true;
      else malformedInterior = true;
      break;
    }

    parsedLines += 1;
    const line = parsed as Record<string, unknown>;

    for (const block of contentBlocks(line)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        pending.set(block.id, true);
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        pending.delete(block.tool_use_id);
      }
    }

    if (pending.size === 0 && typeof line['uuid'] === 'string') {
      lastCoherentUuid = line['uuid'];
    }
  }

  const empty = parsedLines === 0;
  const unpairedToolUseIds = Object.freeze([...pending.keys()]);
  const safeToResume =
    !empty && !tornTail && !malformedInterior && unpairedToolUseIds.length === 0;

  return {
    safeToResume,
    lastCoherentUuid,
    unpairedToolUseIds,
    tornTail,
    malformedInterior,
    empty,
    parsedLines,
  };
}

/**
 * Validate a transcript file on disk. Read-only by construction — this module
 * has no write imports (native stores are never mutated; X4 guardrail).
 * M1 reads the whole file; tail-windowing for very large transcripts is a
 * documented follow-up, not a correctness concern.
 */
export function validateTranscriptTailFile(path: string): TranscriptTailVerdict {
  return validateTranscriptTail(readFileSync(path, 'utf8'));
}
