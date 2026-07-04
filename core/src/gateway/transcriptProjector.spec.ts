/**
 * Transcript projector unit suite — RAW SDK message shapes → frozen
 * transcript.<sid> payloads (ws-protocol.md §9). Every emitted payload must
 * pass the FROZEN validator with the channel's sessionId cross-check.
 *
 * [X2]: all fixtures are SYNTHESIZED SDK-shaped objects — never copied from a
 * real transcript.
 */

import { validateTranscriptPayload } from '@aibender/protocol';
import { describe, expect, it } from 'vitest';

import { createTranscriptProjector } from './transcriptProjector.js';

const SID = 'ses_fake_proj';

function assistantMessage(uuid: string, content: unknown[]): Record<string, unknown> {
  return { type: 'assistant', uuid, session_id: 'native-fake-0', message: { role: 'assistant', content } };
}

function userToolResult(toolUseId: string, isError?: boolean): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'synthuser-0',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          ...(isError !== undefined ? { is_error: isError } : {}),
        },
      ],
    },
  };
}

describe('transcript projector (positive)', () => {
  it('projects assistant text blocks as deltas grouped on the message uuid', () => {
    const projector = createTranscriptProjector(SID);
    const payloads = projector.project(
      assistantMessage('synthmsg-1', [{ type: 'text', text: 'synthesized answer' }]),
    );
    expect(payloads).toEqual([
      { kind: 'transcript-delta', sessionId: SID, messageUuid: 'synthmsg-1', text: 'synthesized answer' },
    ]);
    for (const payload of payloads) expect(validateTranscriptPayload(payload, SID).ok).toBe(true);
  });

  it('projects tool_use blocks as tool starts and pairs the later result by id', () => {
    const projector = createTranscriptProjector(SID);
    const starts = projector.project(
      assistantMessage('synthmsg-2', [
        { type: 'tool_use', id: 'synthtool-1', name: 'Read', input: { file_path: '/synthetic/a' } },
      ]),
    );
    expect(starts).toEqual([
      { kind: 'transcript-tool', sessionId: SID, toolUseId: 'synthtool-1', toolName: 'Read', phase: 'start' },
    ]);

    const results = projector.project(userToolResult('synthtool-1', false));
    expect(results).toEqual([
      {
        kind: 'transcript-tool',
        sessionId: SID,
        toolUseId: 'synthtool-1',
        toolName: 'Read',
        phase: 'result',
        ok: true,
      },
    ]);
    for (const payload of [...starts, ...results]) {
      expect(validateTranscriptPayload(payload, SID).ok).toBe(true);
    }
  });

  it('maps is_error tool results to ok:false', () => {
    const projector = createTranscriptProjector(SID);
    projector.project(assistantMessage('m', [{ type: 'tool_use', id: 'synthtool-2', name: 'Bash' }]));
    const [result] = projector.project(userToolResult('synthtool-2', true));
    expect(result).toMatchObject({ phase: 'result', ok: false, toolName: 'Bash' });
  });

  it('projects the terminal result with the four ground-truth token classes', () => {
    const projector = createTranscriptProjector(SID);
    const payloads = projector.project({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 120,
        output_tokens: 340,
        cache_read_input_tokens: 64,
        cache_creation_input_tokens: 8,
      },
      total_cost_usd: 0.0421,
      duration_ms: 5400,
    });
    expect(payloads).toEqual([
      {
        kind: 'transcript-result',
        sessionId: SID,
        ok: true,
        detail: 'success',
        usage: { inputTokens: 120, outputTokens: 340, cacheReadTokens: 64, cacheCreationTokens: 8 },
        costUsd: 0.0421,
        durationMs: 5400,
      },
    ]);
    expect(validateTranscriptPayload(payloads[0], SID).ok).toBe(true);
  });

  it('projects streamed partial text deltas from stream_event messages', () => {
    const projector = createTranscriptProjector(SID);
    const payloads = projector.project({
      type: 'stream_event',
      uuid: 'synthmsg-3',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk' } },
    });
    expect(payloads).toEqual([
      { kind: 'transcript-delta', sessionId: SID, messageUuid: 'synthmsg-3', text: 'chunk' },
    ]);
  });

  it('unwraps the kernel seam RunnerOtherMessage wrapper', () => {
    const projector = createTranscriptProjector(SID);
    const payloads = projector.project({
      type: 'other',
      raw: assistantMessage('synthmsg-4', [{ type: 'text', text: 'wrapped' }]),
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ kind: 'transcript-delta', text: 'wrapped' });
  });
});

describe('transcript projector (negative — projects to NOTHING, never garbage)', () => {
  it('a failed result with no usage projects zeroed token classes (validator-legal)', () => {
    const projector = createTranscriptProjector(SID);
    const [payload] = projector.project({ type: 'result', subtype: 'error_during_execution' });
    expect(payload).toMatchObject({
      kind: 'transcript-result',
      ok: false,
      detail: 'error_during_execution',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    expect(payload !== undefined && 'costUsd' in payload).toBe(false);
    expect(validateTranscriptPayload(payload, SID).ok).toBe(true);
  });

  it('drops empty text blocks and empty deltas (empty deltas are never sent §9)', () => {
    const projector = createTranscriptProjector(SID);
    expect(projector.project(assistantMessage('m', [{ type: 'text', text: '' }]))).toEqual([]);
    expect(
      projector.project({
        type: 'stream_event',
        uuid: 'm',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      }),
    ).toEqual([]);
  });

  it('skips a tool_result whose start never streamed (no name to render)', () => {
    const projector = createTranscriptProjector(SID);
    expect(projector.project(userToolResult('synthtool-unknown'))).toEqual([]);
  });

  it('projects nothing for init/system/unknown/garbage inputs', () => {
    const projector = createTranscriptProjector(SID);
    expect(projector.project({ type: 'system', subtype: 'init', session_id: 'native-fake-1' })).toEqual([]);
    expect(projector.project({ type: 'mystery' })).toEqual([]);
    expect(projector.project('a string')).toEqual([]);
    expect(projector.project(null)).toEqual([]);
    expect(projector.project(42)).toEqual([]);
    expect(projector.project(['array'])).toEqual([]);
  });

  it('ignores non-text stream_event deltas (input_json_delta etc.)', () => {
    const projector = createTranscriptProjector(SID);
    expect(
      projector.project({
        type: 'stream_event',
        uuid: 'm',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
      }),
    ).toEqual([]);
  });

  it('sanitizes hostile usage/cost values instead of shipping them', () => {
    const projector = createTranscriptProjector(SID);
    const [payload] = projector.project({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: -5, output_tokens: 1.5, cache_read_input_tokens: 'many' },
      total_cost_usd: -1,
      duration_ms: Number.NaN,
    });
    expect(payload).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    expect(payload !== undefined && 'costUsd' in payload).toBe(false);
    expect(payload !== undefined && 'durationMs' in payload).toBe(false);
    expect(validateTranscriptPayload(payload, SID).ok).toBe(true);
  });
});

describe('transcript projector (edge)', () => {
  it('once partial deltas streamed, the final assistant text is NOT re-emitted (no duplication)', () => {
    const projector = createTranscriptProjector(SID);
    const streamed = projector.project({
      type: 'stream_event',
      uuid: 'synthmsg-5',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial ' } },
    });
    expect(streamed).toHaveLength(1);
    const finalMessage = projector.project(
      assistantMessage('synthmsg-5', [
        { type: 'text', text: 'partial and complete' },
        { type: 'tool_use', id: 'synthtool-3', name: 'Write' },
      ]),
    );
    // The text is suppressed; the tool_use start still projects.
    expect(finalMessage).toEqual([
      { kind: 'transcript-tool', sessionId: SID, toolUseId: 'synthtool-3', toolName: 'Write', phase: 'start' },
    ]);
  });

  it('a tool result consumed once does not re-pair on duplicate tool_result blocks', () => {
    const projector = createTranscriptProjector(SID);
    projector.project(assistantMessage('m', [{ type: 'tool_use', id: 'synthtool-4', name: 'Read' }]));
    expect(projector.project(userToolResult('synthtool-4'))).toHaveLength(1);
    expect(projector.project(userToolResult('synthtool-4'))).toEqual([]);
  });

  it('multiple content blocks project in stream order', () => {
    const projector = createTranscriptProjector(SID);
    const payloads = projector.project(
      assistantMessage('synthmsg-6', [
        { type: 'text', text: 'first' },
        { type: 'tool_use', id: 'synthtool-5', name: 'Bash' },
        { type: 'text', text: 'second' },
      ]),
    );
    expect(payloads.map((payload) => payload.kind)).toEqual([
      'transcript-delta',
      'transcript-tool',
      'transcript-delta',
    ]);
  });
});
