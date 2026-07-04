import { describe, expect, it } from 'vitest';

import { PROTOCOL_FREEZE } from '@aibender/protocol';

import {
  GOLDEN_HOOK_CORPUS_FREEZE,
  GOLDEN_HOOK_FIXTURES,
  replayGoldenHookFixture,
} from './hooksGolden.js';
import { assertSynthesizedSafeText } from './jsonl.js';

describe('golden hook-POST fixture corpus (hooks-contract.md §6; M3 freeze)', () => {
  // -- positive ---------------------------------------------------------------

  it('pins the same freeze the protocol package self-identifies as', () => {
    expect(GOLDEN_HOOK_CORPUS_FREEZE).toBe(PROTOCOL_FREEZE);
    expect(GOLDEN_HOOK_CORPUS_FREEZE).toBe('FROZEN-M3');
  });

  it('every fixture replays to its pinned verdict', () => {
    for (const fixture of GOLDEN_HOOK_FIXTURES) {
      const outcome = replayGoldenHookFixture(fixture);
      expect(outcome.accepted, fixture.name).toBe(fixture.expect.accepted);
      if (fixture.expect.accepted) {
        expect(outcome.group, fixture.name).toBe(fixture.expect.group);
        expect(outcome.gatingCapable, fixture.name).toBe(fixture.expect.gatingCapable);
        expect(outcome.relay, fixture.name).toEqual(fixture.expect.relay);
      } else {
        expect(outcome.httpStatus, fixture.name).toBe(fixture.expect.httpStatus);
      }
    }
  });

  it('pins the exact bytes of the gating fixture (serialization guard)', () => {
    const fixture = GOLDEN_HOOK_FIXTURES.find((f) => f.name === 'hook-pretooluse-gating');
    expect(fixture?.bodyJson).toBe(
      '{"hook_event_name":"PreToolUse","session_id":"synth-native-1",' +
        '"transcript_path":"/synthetic/projects/synth/synth-native-1.jsonl",' +
        '"cwd":"/synthetic/workspace","permission_mode":"default","tool_name":"Read",' +
        '"tool_input":{"file_path":"/synthetic/file.ts"},"tool_use_id":"toolu_synth_1"}',
    );
  });

  it('covers both rejection classes and a relay-bearing accept', () => {
    const rejections = GOLDEN_HOOK_FIXTURES.filter((f) => !f.expect.accepted);
    expect(rejections.some((f) => !f.expect.accepted && f.expect.httpStatus === 404)).toBe(true);
    expect(rejections.some((f) => !f.expect.accepted && f.expect.httpStatus === 400)).toBe(true);
    expect(
      GOLDEN_HOOK_FIXTURES.some((f) => f.expect.accepted && f.expect.relay !== undefined),
    ).toBe(true);
  });

  // -- negative ---------------------------------------------------------------

  it('contains no identity-shaped content in any body [X2 fixture policy]', () => {
    for (const fixture of GOLDEN_HOOK_FIXTURES) {
      expect(() => assertSynthesizedSafeText(fixture.bodyJson), fixture.name).not.toThrow();
      expect(() => assertSynthesizedSafeText(fixture.accountSegment), fixture.name).not.toThrow();
    }
  });

  // -- edge -------------------------------------------------------------------

  it('fixture names are unique (fixtures are addressed by name across departments)', () => {
    const names = GOLDEN_HOOK_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exercises every vocabulary group at least once or is deliberately unmapped/rejected', () => {
    const groups = new Set(
      GOLDEN_HOOK_FIXTURES.filter((f) => f.expect.accepted).map(
        (f) => (f.expect as { group: string }).group,
      ),
    );
    for (const group of [
      'session-lifecycle',
      'tool-lifecycle',
      'permission-floor',
      'context-files',
      'compaction',
      'unmapped',
    ]) {
      expect(groups.has(group), `no fixture exercises group ${group}`).toBe(true);
    }
  });
});
