import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// synthesizedTranscript was promoted from ./testing/ into testkit (ICR-0001).
import { synthesizedTranscript } from '@aibender/testkit';

import { validateTranscriptTail, validateTranscriptTailFile } from './transcriptTail.js';

const scratchRoots: string[] = [];
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

describe('transcript-tail validator (BE-1; blueprint §4.1)', () => {
  // -- positive ---------------------------------------------------------------

  it('a clean tail with fully-paired tool calls is safe to resume', () => {
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'user' },
        { kind: 'assistant' },
        { kind: 'tool-call', paired: true },
        { kind: 'assistant' },
      ],
    });
    const verdict = validateTranscriptTail(fixture.jsonl);
    expect(verdict.safeToResume).toBe(true);
    expect(verdict.unpairedToolUseIds).toEqual([]);
    expect(verdict.tornTail).toBe(false);
    expect(verdict.lastCoherentUuid).toBe(fixture.uuids.at(-1));
    expect(verdict.parsedLines).toBe(5); // tool-call = 2 lines
  });

  it('a text-only conversation is safe to resume', () => {
    const fixture = synthesizedTranscript({
      steps: [{ kind: 'user' }, { kind: 'assistant' }],
    });
    expect(validateTranscriptTail(fixture.jsonl).safeToResume).toBe(true);
  });

  // -- negative ---------------------------------------------------------------

  it('detects an incomplete tool_use/tool_result pairing (mid-tool-call kill)', () => {
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'user' },
        { kind: 'assistant' },
        { kind: 'tool-call', paired: false }, // the dangling call
      ],
    });
    const verdict = validateTranscriptTail(fixture.jsonl);
    expect(verdict.safeToResume).toBe(false);
    expect(verdict.unpairedToolUseIds).toEqual(fixture.unpairedToolUseIds);
    // The repair anchor is the last message BEFORE the dangling tool call.
    expect(verdict.lastCoherentUuid).toBe(fixture.uuids[1]);
  });

  it('an empty transcript is not resumable and offers no anchor', () => {
    const verdict = validateTranscriptTail('');
    expect(verdict.safeToResume).toBe(false);
    expect(verdict.empty).toBe(true);
    expect(verdict.lastCoherentUuid).toBeNull();
  });

  it('a malformed interior line breaks the coherence chain at that point', () => {
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'user' },
        { kind: 'assistant' },
        { kind: 'malformed' },
        { kind: 'assistant' }, // untrusted: after the break
      ],
    });
    const verdict = validateTranscriptTail(fixture.jsonl);
    expect(verdict.safeToResume).toBe(false);
    expect(verdict.malformedInterior).toBe(true);
    // Anchor = last coherent message BEFORE the malformed line.
    expect(verdict.lastCoherentUuid).toBe(fixture.uuids[1]);
  });

  // -- edge -------------------------------------------------------------------

  it('a torn final line (SIGKILL mid-append) is skipped but forces repair', () => {
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'user' },
        { kind: 'assistant' },
        { kind: 'tool-call', paired: true },
        { kind: 'torn' },
      ],
    });
    expect(fixture.jsonl.endsWith('\n')).toBe(false); // really torn
    const verdict = validateTranscriptTail(fixture.jsonl);
    expect(verdict.tornTail).toBe(true);
    expect(verdict.safeToResume).toBe(false);
    // Anchor = the last COMPLETE line (the paired tool_result).
    expect(verdict.lastCoherentUuid).toBe(fixture.uuids.at(-1));
  });

  it('torn tail after a dangling tool call anchors before the call', () => {
    const fixture = synthesizedTranscript({
      steps: [{ kind: 'user' }, { kind: 'tool-call', paired: false }, { kind: 'torn' }],
    });
    const verdict = validateTranscriptTail(fixture.jsonl);
    expect(verdict.safeToResume).toBe(false);
    expect(verdict.tornTail).toBe(true);
    expect(verdict.unpairedToolUseIds).toHaveLength(1);
    expect(verdict.lastCoherentUuid).toBe(fixture.uuids[0]);
  });

  it('multiple interleaved tool calls resolve pairing by id, not by order', () => {
    // call A (paired), call B (unpaired): the anchor is A's result only if
    // B is not yet pending there — B opens after, so anchor = A's result line.
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'tool-call', paired: true },
        { kind: 'tool-call', paired: false },
      ],
    });
    const verdict = validateTranscriptTail(fixture.jsonl);
    expect(verdict.safeToResume).toBe(false);
    expect(verdict.unpairedToolUseIds).toEqual(['synthtool-1']);
    expect(verdict.lastCoherentUuid).toBe(fixture.uuids[1]);
  });

  it('reads from disk via validateTranscriptTailFile (read-only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibender-transcripts-'));
    scratchRoots.push(dir);
    const fixture = synthesizedTranscript({
      steps: [{ kind: 'user' }, { kind: 'assistant' }],
    });
    const path = join(dir, 'synth-native-session.jsonl');
    writeFileSync(path, fixture.jsonl);
    expect(validateTranscriptTailFile(path).safeToResume).toBe(true);
  });

  it('whitespace-only trailing segments do not count as torn tails', () => {
    const fixture = synthesizedTranscript({ steps: [{ kind: 'user' }] });
    const verdict = validateTranscriptTail(`${fixture.jsonl}\n  \n`);
    expect(verdict.tornTail).toBe(false);
    expect(verdict.safeToResume).toBe(true);
  });
});
