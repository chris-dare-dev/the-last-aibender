/**
 * Transcript read model — the store side of the streaming discipline.
 *
 * Deltas NEVER hit this store one-by-one: the binder buffers them in a
 * non-reactive ring and applies ONE `set()` per animation frame
 * (`applyBatch`). Blocks are DOCUMENT BLOCKS grouped on `messageUuid`
 * (DESIGN.md §7 item 14: transcripts are never chat bubbles).
 *
 * Bounded: at most {@link MAX_BLOCKS_PER_SESSION} blocks are retained per
 * session (drop-oldest, counted) — the transcript of record lives in the
 * per-account JSONL files, not in this projection.
 */

import { createStore } from 'zustand/vanilla';
import type { TranscriptPayload, TranscriptResult } from '@aibender/protocol';

export const MAX_BLOCKS_PER_SESSION = 1000;
export const MAX_TOOL_EVENTS_PER_SESSION = 500;

export interface TranscriptBlock {
  readonly messageUuid: string;
  readonly text: string;
}

export interface ToolEventRow {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly phase: 'start' | 'result';
  readonly ok?: boolean;
}

export interface SessionTranscript {
  readonly blocks: readonly TranscriptBlock[];
  readonly tools: readonly ToolEventRow[];
  readonly result: TranscriptResult | undefined;
  readonly droppedBlocks: number;
}

const EMPTY_SESSION: SessionTranscript = {
  blocks: [],
  tools: [],
  result: undefined,
  droppedBlocks: 0,
};

export interface TranscriptBatchItem {
  readonly sessionId: string;
  readonly payload: TranscriptPayload;
}

export interface TranscriptStoreState {
  readonly sessions: Readonly<Record<string, SessionTranscript>>;
  /** ONE reactive update per frame batch — the render-count contract. */
  applyBatch(items: readonly TranscriptBatchItem[]): void;
  reset(): void;
}

function applyToSession(
  session: SessionTranscript,
  payload: TranscriptPayload,
): SessionTranscript {
  switch (payload.kind) {
    case 'transcript-delta': {
      const blocks = [...session.blocks];
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.messageUuid === payload.messageUuid) {
        blocks[blocks.length - 1] = { messageUuid: last.messageUuid, text: last.text + payload.text };
      } else {
        blocks.push({ messageUuid: payload.messageUuid, text: payload.text });
      }
      let dropped = session.droppedBlocks;
      while (blocks.length > MAX_BLOCKS_PER_SESSION) {
        blocks.shift();
        dropped += 1;
      }
      return { ...session, blocks, droppedBlocks: dropped };
    }
    case 'transcript-tool': {
      const tools = [...session.tools];
      if (payload.phase === 'result') {
        const idx = tools.findIndex(
          (t) => t.toolUseId === payload.toolUseId && t.phase === 'start',
        );
        const row: ToolEventRow = {
          toolUseId: payload.toolUseId,
          toolName: payload.toolName,
          phase: 'result',
          ...(payload.ok !== undefined ? { ok: payload.ok } : {}),
        };
        if (idx >= 0) tools[idx] = row;
        else tools.push(row);
      } else {
        tools.push({
          toolUseId: payload.toolUseId,
          toolName: payload.toolName,
          phase: 'start',
        });
      }
      while (tools.length > MAX_TOOL_EVENTS_PER_SESSION) tools.shift();
      return { ...session, tools };
    }
    case 'transcript-result':
      return { ...session, result: payload };
    default:
      return session;
  }
}

export const transcriptStore = createStore<TranscriptStoreState>()((set) => ({
  sessions: {},

  applyBatch: (items) => {
    if (items.length === 0) return;
    set((s) => {
      const next: Record<string, SessionTranscript> = { ...s.sessions };
      for (const item of items) {
        next[item.sessionId] = applyToSession(
          next[item.sessionId] ?? EMPTY_SESSION,
          item.payload,
        );
      }
      return { sessions: next };
    });
  },

  reset: () => set({ sessions: {} }),
}));

export type TranscriptStore = typeof transcriptStore;
