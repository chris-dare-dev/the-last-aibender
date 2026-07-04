/**
 * Transcript read model — unit coverage (plan §9.2 FE-3) + replay of the
 * EXISTING golden `transcript.<sid>` corpus (packages/testkit) through the
 * frozen validator → model path, mirroring the FE-2 client's routing order.
 */

import { describe, expect, it } from 'vitest';
import { validateTranscriptPayload, type TranscriptPayload } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, type GoldenWsTextFixture } from '@aibender/testkit';
import { createTranscriptStore } from './model.ts';

const SID = 'ses_fake_1';

const delta = (uuid: string, text: string): TranscriptPayload => ({
  kind: 'transcript-delta',
  sessionId: SID,
  messageUuid: uuid,
  text,
});

describe('createTranscriptStore', () => {
  it('groups deltas into one text block per messageUuid (the wire grouping key)', () => {
    const store = createTranscriptStore(SID);
    store.apply(delta('m1', 'hello'));
    store.apply(delta('m1', ' world'));
    store.apply(delta('m2', 'second message'));
    store.apply(delta('m1', '!'));
    const items = store.getSnapshot().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'text', messageUuid: 'm1', text: 'hello world!' });
    expect(items[1]).toMatchObject({ kind: 'text', messageUuid: 'm2', text: 'second message' });
  });

  it('pairs tool start with its result on toolUseId', () => {
    const store = createTranscriptStore(SID);
    store.apply({
      kind: 'transcript-tool',
      sessionId: SID,
      toolUseId: 'tu1',
      toolName: 'Read',
      phase: 'start',
    });
    expect(store.getSnapshot().items[0]).toMatchObject({ kind: 'tool', status: 'running' });
    store.apply({
      kind: 'transcript-tool',
      sessionId: SID,
      toolUseId: 'tu1',
      toolName: 'Read',
      phase: 'result',
      ok: true,
    });
    const items = store.getSnapshot().items;
    expect(items).toHaveLength(1); // updated in place, not duplicated
    expect(items[0]).toMatchObject({ kind: 'tool', toolName: 'Read', status: 'ok' });
  });

  it('maps ok:false results to error status; result-without-start still renders (reconnect edge)', () => {
    const store = createTranscriptStore(SID);
    store.apply({
      kind: 'transcript-tool',
      sessionId: SID,
      toolUseId: 'tu9',
      toolName: 'Bash',
      phase: 'result',
      ok: false,
    });
    expect(store.getSnapshot().items[0]).toMatchObject({
      kind: 'tool',
      toolUseId: 'tu9',
      status: 'error',
    });
  });

  it('appends terminal results with the four ground-truth token classes', () => {
    const store = createTranscriptStore(SID);
    store.apply({
      kind: 'transcript-result',
      sessionId: SID,
      ok: true,
      detail: 'success',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
      costUsd: 0.05,
      durationMs: 1234,
    });
    expect(store.getSnapshot().items[0]).toMatchObject({
      kind: 'result',
      ok: true,
      detail: 'success',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
      costUsd: 0.05,
      durationMs: 1234,
    });
  });

  it('drops session-mismatched payloads without corrupting the transcript', () => {
    const store = createTranscriptStore(SID);
    store.apply(delta('m1', 'mine'));
    store.apply({
      kind: 'transcript-delta',
      sessionId: 'ses_fake_2',
      messageUuid: 'm1',
      text: 'NOT MINE',
    });
    const snap = store.getSnapshot();
    expect(snap.items).toHaveLength(1);
    expect((snap.items[0] as { text: string }).text).toBe('mine');
    expect(snap.droppedCount).toBe(1);
  });

  it('notifies subscribers once per apply and once per applyMany batch', () => {
    const store = createTranscriptStore(SID);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.apply(delta('m1', 'a'));
    expect(notified).toBe(1);
    store.applyMany([delta('m1', 'b'), delta('m2', 'c'), delta('m2', 'd')]);
    expect(notified).toBe(2); // ONE notification for the batch (rAF projection)
    expect(store.getSnapshot().items).toHaveLength(2);
    unsubscribe();
    store.apply(delta('m1', 'e'));
    expect(notified).toBe(2);
  });

  it('keeps snapshots immutable across mutations (react store discipline)', () => {
    const store = createTranscriptStore(SID);
    store.apply(delta('m1', 'a'));
    const before = store.getSnapshot();
    store.apply(delta('m1', 'b'));
    const after = store.getSnapshot();
    expect(before).not.toBe(after);
    expect(before.items).not.toBe(after.items);
    expect((before.items[0] as { text: string }).text).toBe('a');
    expect(after.version).toBeGreaterThan(before.version);
  });

  describe('golden transcript corpus replay (packages/testkit — the BE↔FE device)', () => {
    const transcriptFixtures = GOLDEN_WS_FIXTURES.filter(
      (f): f is GoldenWsTextFixture => f.kind === 'text' && f.stage === 'transcript-payload',
    );

    it('has both valid and invalid transcript fixtures pinned', () => {
      expect(transcriptFixtures.some((f) => f.expect.valid)).toBe(true);
      expect(transcriptFixtures.some((f) => !f.expect.valid)).toBe(true);
    });

    it('folds every VALID fixture through validator → model (the client routing order)', () => {
      const store = createTranscriptStore(SID);
      for (const fixture of transcriptFixtures.filter((f) => f.expect.valid)) {
        const envelope = JSON.parse(fixture.frame) as { payload: unknown };
        const verdict = validateTranscriptPayload(envelope.payload, SID);
        expect(verdict.ok, fixture.name).toBe(true);
        if (verdict.ok) store.apply(verdict.value);
      }
      const items = store.getSnapshot().items;
      // transcript-delta-valid → one text block
      expect(items.filter((i) => i.kind === 'text')).toHaveLength(1);
      expect(items.find((i) => i.kind === 'text')).toMatchObject({
        text: 'synthesized streamed text',
      });
      // tool start + result fixtures share toolUseId → ONE row, resolved ok
      const tools = items.filter((i) => i.kind === 'tool');
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ toolName: 'Read', status: 'ok' });
      // transcript-result-valid → terminal block with the pinned usage
      const results = items.filter((i) => i.kind === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        ok: true,
        detail: 'success',
        usage: { inputTokens: 120, outputTokens: 340, cacheReadTokens: 64, cacheCreationTokens: 8 },
        costUsd: 0.0421,
        durationMs: 5400,
      });
      expect(store.getSnapshot().droppedCount).toBe(0);
    });

    it('every INVALID fixture is rejected by the frozen validator with the pinned code (never reaches the model)', () => {
      for (const fixture of transcriptFixtures.filter((f) => !f.expect.valid)) {
        const envelope = JSON.parse(fixture.frame) as { payload: unknown };
        const verdict = validateTranscriptPayload(envelope.payload, SID);
        expect(verdict.ok, fixture.name).toBe(false);
        if (!verdict.ok && !fixture.expect.valid) {
          expect(verdict.code, fixture.name).toBe(fixture.expect.code);
        }
      }
    });
  });
});
