/**
 * Transcript read model — folds the FROZEN `transcript.<sid>` payload union
 * (ws-protocol.md §9; packages/protocol transcript.ts) into render items for
 * the transcript island:
 *
 *  - `transcript-delta`  → text blocks grouped on `messageUuid` (the wire
 *    contract's client-side grouping key);
 *  - `transcript-tool`   → one tool row per `toolUseId`; `start` opens it
 *    running, `result` closes it ok/error (inputs/outputs are deliberately
 *    NOT on this wire — the row renders name + outcome only);
 *  - `transcript-result` → a terminal result block with the four
 *    ground-truth token classes; `costUsd` is an ESTIMATE by contract.
 *
 * The store is `useSyncExternalStore`-shaped so the island (and FE-2's
 * stores) can subscribe without adapters. Snapshots are immutable; appends
 * and tail-extends copy the items array — the exact shape SPIKE-C streamed
 * through react-virtual at token rate with zero jank.
 *
 * Feeding discipline: the FE-2 WS client validates payloads on the wire
 * (`validateTranscriptPayload`) BEFORE they reach this model; the model
 * still cross-checks the session id and drops mismatches (defense in depth
 * — a mismatched payload must never corrupt another session's transcript).
 */

import type { TranscriptPayload, TranscriptUsage } from '@aibender/protocol';

export interface TranscriptTextItem {
  readonly kind: 'text';
  readonly key: string;
  readonly messageUuid: string;
  readonly text: string;
}

export type TranscriptToolStatus = 'running' | 'ok' | 'error';

export interface TranscriptToolItem {
  readonly kind: 'tool';
  readonly key: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly status: TranscriptToolStatus;
}

export interface TranscriptResultItem {
  readonly kind: 'result';
  readonly key: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly usage: TranscriptUsage;
  readonly costUsd?: number;
  readonly durationMs?: number;
}

export type TranscriptItem = TranscriptTextItem | TranscriptToolItem | TranscriptResultItem;

export interface TranscriptSnapshot {
  readonly sessionId: string;
  readonly items: readonly TranscriptItem[];
  /** Bumped on every accepted mutation (memo key for projections). */
  readonly version: number;
  /** Payloads dropped by the session cross-check (observability for tests). */
  readonly droppedCount: number;
}

/** The island↔store seam (useSyncExternalStore-compatible). */
export interface TranscriptFeed {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TranscriptSnapshot;
}

export interface TranscriptStore extends TranscriptFeed {
  apply(payload: TranscriptPayload): void;
  /** Batch apply with ONE notification — the rAF-projection entry point. */
  applyMany(payloads: readonly TranscriptPayload[]): void;
}

export function createTranscriptStore(sessionId: string): TranscriptStore {
  let items: TranscriptItem[] = [];
  let version = 0;
  let droppedCount = 0;
  let snapshot: TranscriptSnapshot = { sessionId, items, version, droppedCount };
  const listeners = new Set<() => void>();
  /** messageUuid → items index (delta grouping). */
  const textIndex = new Map<string, number>();
  /** toolUseId → items index (start/result pairing). */
  const toolIndex = new Map<string, number>();
  let resultSeq = 0;

  const notify = (): void => {
    snapshot = { sessionId, items, version, droppedCount };
    for (const listener of [...listeners]) listener();
  };

  const applyOne = (payload: TranscriptPayload): boolean => {
    if (payload.sessionId !== sessionId) {
      droppedCount += 1;
      return true; // snapshot changes (droppedCount) — still notify
    }
    switch (payload.kind) {
      case 'transcript-delta': {
        const existing = textIndex.get(payload.messageUuid);
        if (existing === undefined) {
          textIndex.set(payload.messageUuid, items.length);
          items = [
            ...items,
            {
              kind: 'text',
              key: `t:${payload.messageUuid}`,
              messageUuid: payload.messageUuid,
              text: payload.text,
            },
          ];
        } else {
          const current = items[existing];
          if (current === undefined || current.kind !== 'text') return false;
          const next: TranscriptTextItem = { ...current, text: current.text + payload.text };
          items = items.slice();
          items[existing] = next;
        }
        version += 1;
        return true;
      }
      case 'transcript-tool': {
        const existing = toolIndex.get(payload.toolUseId);
        if (payload.phase === 'start') {
          if (existing !== undefined) return false; // duplicate start — inert
          toolIndex.set(payload.toolUseId, items.length);
          items = [
            ...items,
            {
              kind: 'tool',
              key: `u:${payload.toolUseId}`,
              toolUseId: payload.toolUseId,
              toolName: payload.toolName,
              status: 'running',
            },
          ];
          version += 1;
          return true;
        }
        // phase === 'result' — ok is REQUIRED here by the frozen contract.
        const status: TranscriptToolStatus = payload.ok === true ? 'ok' : 'error';
        if (existing === undefined) {
          // Result without a start (reconnect edge) — render the outcome row.
          toolIndex.set(payload.toolUseId, items.length);
          items = [
            ...items,
            {
              kind: 'tool',
              key: `u:${payload.toolUseId}`,
              toolUseId: payload.toolUseId,
              toolName: payload.toolName,
              status,
            },
          ];
        } else {
          const current = items[existing];
          if (current === undefined || current.kind !== 'tool') return false;
          items = items.slice();
          items[existing] = { ...current, status };
        }
        version += 1;
        return true;
      }
      case 'transcript-result': {
        resultSeq += 1;
        items = [
          ...items,
          {
            kind: 'result',
            key: `r:${resultSeq}`,
            ok: payload.ok,
            detail: payload.detail,
            usage: payload.usage,
            ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
            ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
          },
        ];
        version += 1;
        return true;
      }
    }
  };

  return {
    apply(payload: TranscriptPayload): void {
      if (applyOne(payload)) notify();
    },
    applyMany(payloads: readonly TranscriptPayload[]): void {
      let changed = false;
      for (const payload of payloads) {
        if (applyOne(payload)) changed = true;
      }
      if (changed) notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): TranscriptSnapshot {
      return snapshot;
    },
  };
}
