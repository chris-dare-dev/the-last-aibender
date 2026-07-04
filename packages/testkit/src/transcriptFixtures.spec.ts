import { describe, expect, it } from 'vitest';

import { synthesizedTranscript } from './transcriptFixtures.js';

describe('synthesized transcript fixtures (X2 fixture policy; promoted via ICR-0001)', () => {
  // -- positive ---------------------------------------------------------------

  it('is deterministic for identical options', () => {
    const options = {
      steps: [
        { kind: 'user' as const },
        { kind: 'tool-call' as const, paired: true },
        { kind: 'assistant' as const },
      ],
    };
    expect(synthesizedTranscript(options)).toEqual(synthesizedTranscript(options));
  });

  it('marks every line as synthesized and uses only placeholder identities', () => {
    const fixture = synthesizedTranscript({
      account: 'MAX_B',
      steps: [{ kind: 'user' }, { kind: 'tool-call', paired: false }],
    });
    for (const line of fixture.jsonl.trimEnd().split('\n')) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed['synthesized']).toBe(true);
      expect(parsed['account']).toBe('MAX_B');
    }
  });

  // -- negative ---------------------------------------------------------------

  it('refuses a torn step anywhere but the end (a torn tail is by definition final)', () => {
    expect(() =>
      synthesizedTranscript({ steps: [{ kind: 'torn' }, { kind: 'user' }] }),
    ).toThrow(RangeError);
  });

  // -- edge -------------------------------------------------------------------

  it('a torn transcript really ends without a newline; a clean one with one', () => {
    const torn = synthesizedTranscript({ steps: [{ kind: 'user' }, { kind: 'torn' }] });
    expect(torn.jsonl.endsWith('\n')).toBe(false);
    const clean = synthesizedTranscript({ steps: [{ kind: 'user' }] });
    expect(clean.jsonl.endsWith('\n')).toBe(true);
  });

  it('tracks unpaired tool_use ids in order', () => {
    const fixture = synthesizedTranscript({
      steps: [
        { kind: 'tool-call', paired: false },
        { kind: 'tool-call', paired: true },
        { kind: 'tool-call', paired: false },
      ],
    });
    expect(fixture.unpairedToolUseIds).toEqual(['synthtool-0', 'synthtool-2']);
  });
});
