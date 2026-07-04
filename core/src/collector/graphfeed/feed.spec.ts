/**
 * BE-6 graphfeed tests (plan §9.2): positive — watcher events project into
 * FROZEN §12 payloads and reach the sink; negative — identity-bearing or
 * malformed inputs are dropped, never published, never thrown; edge —
 * unknown tools/events produce no touches, native-id relay policy.
 *
 * FIXTURE POLICY [X2]: every body below is synthesized (synthetic paths,
 * `nat-ses-*` ids); no account identifiers anywhere near the feed inputs.
 */

import {
  validateContextGraphTouch,
  validateHookPost,
  type AcceptedHookPost,
  type ContextGraphTouch,
} from '@aibender/protocol';
import { describe, expect, it } from 'vitest';

import { createGraphFeed, type ContextGraphSink } from './feed.js';
import { touchesFromHookPost } from './hookTouches.js';
import { absolutePathsFrom, relationForTool } from './relations.js';

const CLOCK = (): number => 90_100_000;

function acceptedPost(body: Record<string, unknown>): AcceptedHookPost {
  const outcome = validateHookPost('MAX_A', {
    session_id: 'nat-ses-01',
    ...body,
  });
  if (!outcome.ok) throw new Error(`fixture must validate: ${JSON.stringify(body)}`);
  return outcome.accepted;
}

function capturingSink(): ContextGraphSink & { readonly touches: ContextGraphTouch[] } {
  const touches: ContextGraphTouch[] = [];
  return {
    touches,
    publishContextTouch: (touch) => {
      touches.push(touch);
    },
  };
}

describe('relations', () => {
  it('maps read-shaped and write-shaped tools, refuses to guess for the rest', () => {
    expect(relationForTool('Read')).toBe('read');
    expect(relationForTool('Grep')).toBe('read');
    expect(relationForTool('Write')).toBe('write');
    expect(relationForTool('NotebookEdit')).toBe('write');
    expect(relationForTool('Bash')).toBeUndefined();
    expect(relationForTool('SomeFutureTool')).toBeUndefined();
  });

  it('extracts only absolute paths, deduped, from record candidates', () => {
    expect(
      absolutePathsFrom({ file_path: '/synthetic/a.ts', path: '/synthetic/a.ts' }),
    ).toEqual(['/synthetic/a.ts']);
    expect(absolutePathsFrom({ file_path: 'relative/nope.ts' })).toEqual([]);
    expect(absolutePathsFrom({ file_path: 42 })).toEqual([]);
    expect(absolutePathsFrom('not-a-record')).toEqual([]);
    expect(absolutePathsFrom(null)).toEqual([]);
  });
});

describe('touchesFromHookPost', () => {
  it('PostToolUse on a read-shaped tool → read touch per absolute path', () => {
    const accepted = acceptedPost({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/synthetic/read-me.md' },
    });
    const touches = touchesFromHookPost(accepted, { clock: CLOCK });
    expect(touches).toEqual([
      {
        kind: 'context-touch',
        sessionId: 'nat-ses-01',
        path: '/synthetic/read-me.md',
        relation: 'read',
        ts: 90_100_000,
      },
    ]);
    // The projection output IS the frozen wire shape.
    expect(validateContextGraphTouch(touches[0]).ok).toBe(true);
  });

  it('PostToolUse on a write-shaped tool → write touch', () => {
    const accepted = acceptedPost({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/synthetic/edited.ts' },
    });
    expect(touchesFromHookPost(accepted, { clock: CLOCK })[0]?.relation).toBe('write');
  });

  it('InstructionsLoaded → instructions, FileChanged → watched (§12 table)', () => {
    const instructions = acceptedPost({
      hook_event_name: 'InstructionsLoaded',
      file_path: '/synthetic/CLAUDE.md',
    });
    expect(touchesFromHookPost(instructions, { clock: CLOCK })[0]?.relation).toBe('instructions');

    const watched = acceptedPost({
      hook_event_name: 'FileChanged',
      file_path: '/synthetic/watched.md',
    });
    expect(touchesFromHookPost(watched, { clock: CLOCK })[0]?.relation).toBe('watched');
  });

  it('non-file tools, unknown events, and non-string tool names produce NO touches', () => {
    expect(
      touchesFromHookPost(
        acceptedPost({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        }),
        { clock: CLOCK },
      ),
    ).toEqual([]);
    expect(
      touchesFromHookPost(acceptedPost({ hook_event_name: 'SessionEnd' }), { clock: CLOCK }),
    ).toEqual([]);
    expect(
      touchesFromHookPost(
        acceptedPost({ hook_event_name: 'PostToolUse', tool_name: 42, tool_input: {} }),
        { clock: CLOCK },
      ),
    ).toEqual([]);
  });

  it('session resolver maps native → harness ids; undefined drops the touch', () => {
    const accepted = acceptedPost({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/synthetic/a.ts' },
    });
    const mapped = touchesFromHookPost(accepted, {
      clock: CLOCK,
      resolveSessionId: () => 'ses_harness_01',
    });
    expect(mapped[0]?.sessionId).toBe('ses_harness_01');

    const dropped = touchesFromHookPost(accepted, {
      clock: CLOCK,
      resolveSessionId: () => undefined,
    });
    expect(dropped).toEqual([]);
  });

  it('[X2] never copies the account label into a touch', () => {
    const accepted = acceptedPost({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/synthetic/a.ts' },
    });
    const touches = touchesFromHookPost(accepted, { clock: CLOCK });
    for (const touch of touches) {
      expect('account' in touch).toBe(false);
      expect('accountLabel' in touch).toBe(false);
    }
  });
});

describe('createGraphFeed', () => {
  it('publishes hook-post and watcher touches through the sink (positive e2e)', () => {
    const sink = capturingSink();
    const feed = createGraphFeed({ sink, clock: CLOCK });

    const count = feed.ingestHookPost(
      acceptedPost({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/synthetic/from-hook.ts' },
      }),
    );
    expect(count).toBe(1);

    expect(
      feed.ingestWatcherTouch({
        sessionId: 'ses_jsonl_01',
        path: '/synthetic/from-jsonl.ts',
        relation: 'read',
        ts: 90_100_500,
      }),
    ).toBe(true);

    expect(sink.touches).toHaveLength(2);
    for (const touch of sink.touches) {
      expect(validateContextGraphTouch(touch).ok).toBe(true);
    }
    expect(sink.touches[1]).toEqual({
      kind: 'context-touch',
      sessionId: 'ses_jsonl_01',
      path: '/synthetic/from-jsonl.ts',
      relation: 'read',
      ts: 90_100_500,
    });
    expect(feed.stats()).toEqual({ published: 2, dropped: 0, droppedByReason: {} });
  });

  it('watcher ts defaults to the feed clock', () => {
    const sink = capturingSink();
    const feed = createGraphFeed({ sink, clock: CLOCK });
    feed.ingestWatcherTouch({
      sessionId: 'ses_01',
      path: '/synthetic/a.ts',
      relation: 'watched',
    });
    expect(sink.touches[0]?.ts).toBe(90_100_000);
  });

  it('[X2] rejects watcher touches that even carry an account key', () => {
    const sink = capturingSink();
    const feed = createGraphFeed({ sink, clock: CLOCK });
    const poisoned = {
      sessionId: 'ses_01',
      path: '/synthetic/a.ts',
      relation: 'read',
      account: 'MAX_A',
    } as never;
    expect(feed.ingestWatcherTouch(poisoned)).toBe(false);
    expect(sink.touches).toHaveLength(0);
    expect(feed.stats().droppedByReason['account-key']).toBe(1);
  });

  it('drops (never throws, never publishes) malformed wire-derived touches', () => {
    const sink = capturingSink();
    const feed = createGraphFeed({ sink, clock: CLOCK });

    // Relative path.
    expect(
      feed.ingestWatcherTouch({ sessionId: 'ses_01', path: 'rel/nope.ts', relation: 'read' }),
    ).toBe(false);
    // Malformed session id (charset violation).
    expect(
      feed.ingestWatcherTouch({ sessionId: 'bad id!', path: '/synthetic/a.ts', relation: 'read' }),
    ).toBe(false);
    // Unknown relation.
    expect(
      feed.ingestWatcherTouch({
        sessionId: 'ses_01',
        path: '/synthetic/a.ts',
        relation: 'executed' as never,
      }),
    ).toBe(false);

    expect(sink.touches).toHaveLength(0);
    expect(feed.stats().dropped).toBe(3);
    expect(feed.stats().droppedByReason['invalid-payload']).toBe(3);
  });

  it('hook posts whose native session id fails the wire charset are dropped, not rewritten', () => {
    const sink = capturingSink();
    const feed = createGraphFeed({ sink, clock: CLOCK });
    const outcome = validateHookPost('MAX_A', {
      session_id: 'has spaces — not a wire id',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/synthetic/a.ts' },
    });
    if (!outcome.ok) throw new Error('fixture must validate');
    expect(feed.ingestHookPost(outcome.accepted)).toBe(0);
    expect(feed.stats().droppedByReason['invalid-payload']).toBe(1);
  });
});
