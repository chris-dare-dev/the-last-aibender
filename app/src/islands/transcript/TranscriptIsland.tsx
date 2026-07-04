/**
 * FE-3 transcript island — react-virtual windowing in end-anchored mode with
 * the SPIKE-C follow-guard owning the follow discipline (followGuard.ts —
 * the library's followOnAppend/isAtEnd are NOT trusted for follow; measured
 * verdict in docs/spikes/spike-c-virtual-term.md).
 *
 * Renders the FROZEN transcript payload projection (model.ts) as DOCUMENT
 * BLOCKS on the monospace character grid — never chat bubbles (DESIGN.md §7
 * item 14). Styling is token-only (transcript.css); status hues are paired
 * with engraved text readouts (DESIGN.md §9); the LIVE indicator is driven
 * by the guard's follow-intent, with a JUMP TO LIVE control when released.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createFollowGuard, type FollowGuard } from './followGuard.ts';
import type {
  TranscriptFeed,
  TranscriptItem,
  TranscriptResultItem,
  TranscriptToolItem,
} from './model.ts';
import './transcript.css';

export interface TranscriptIslandProps {
  feed: TranscriptFeed;
}

/** Grid-row estimate (--ig-grid-row is 20px); measureElement refines it. */
const ROW_ESTIMATE_PX = 20;
const OVERSCAN_ROWS = 10;

const STATUS_READOUT: Record<TranscriptToolItem['status'], string> = {
  running: '…', // mono ellipsis ticker — the sanctioned busy readout
  ok: 'OK',
  error: 'FAULT',
};

function ToolRow({ item }: { item: TranscriptToolItem }): JSX.Element {
  return (
    <div className={`tr-tool tr-tool--${item.status}`}>
      <span className="tr-engraved">tool</span> <span className="tr-tool-name">{item.toolName}</span>{' '}
      <span className={`tr-tool-status tr-tool-status--${item.status}`}>
        {STATUS_READOUT[item.status]}
      </span>
    </div>
  );
}

function ResultRow({ item }: { item: TranscriptResultItem }): JSX.Element {
  const { usage } = item;
  return (
    <div className={`tr-result ${item.ok ? 'tr-result--ok' : 'tr-result--fault'}`}>
      <span className="tr-engraved">result</span>{' '}
      <span className="tr-result-outcome">{item.ok ? 'OK' : 'FAULT'}</span>{' '}
      <span className="tr-result-detail">{item.detail}</span>
      <span className="tr-result-usage">
        {' '}
        in {usage.inputTokens} out {usage.outputTokens} cr {usage.cacheReadTokens} cw{' '}
        {usage.cacheCreationTokens}
        {item.costUsd !== undefined ? ` est $${item.costUsd.toFixed(4)}` : ''}
        {item.durationMs !== undefined ? ` ${(item.durationMs / 1000).toFixed(1)}s` : ''}
      </span>
    </div>
  );
}

function renderItem(item: TranscriptItem): JSX.Element {
  switch (item.kind) {
    case 'text':
      return <div className="tr-text">{item.text}</div>;
    case 'tool':
      return <ToolRow item={item} />;
    case 'result':
      return <ResultRow item={item} />;
  }
}

export function TranscriptIsland({ feed }: TranscriptIslandProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const guardRef = useRef<FollowGuard | null>(null);
  const [live, setLive] = useState(true);
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const items = snapshot.items;

  // Phosphor gating: animate a block only on ARRIVAL (first render of its
  // key), never again when virtualization re-mounts it during scrollback.
  // Pre-populated at mount so restoring an existing transcript stays calm.
  const animatedKeysRef = useRef<Set<string> | null>(null);
  if (animatedKeysRef.current === null) {
    animatedKeysRef.current = new Set(items.map((item) => item.key));
  }
  const animatedKeys = animatedKeysRef.current;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN_ROWS,
    getItemKey: (index) => items[index]?.key ?? index,
    // SPIKE-C verdict clause 1: keep anchorTo:'end' for its item-growth
    // compensation, but the follow-guard owns the follow discipline —
    // followOnAppend stays false (the library default) because a
    // library-driven scroll on append relies on the virtualizer's isAtEnd(),
    // whose internal scrollOffset lags the DOM by a frame: an append landing
    // right after a wheel-up release reads isAtEnd()==true and yanks the
    // reader back to the live edge while the guard is released (verified by
    // frame trace — the M2 fix-phase reader-yank-back finding). Appends while
    // following are covered by the guard's per-rAF pin.
    anchorTo: 'end',
    followOnAppend: false,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return undefined;
    const guard = createFollowGuard(el, { onFollowChange: setLive });
    guardRef.current = guard;
    return () => {
      guard.dispose();
      guardRef.current = null;
    };
  }, []);

  const jumpToLive = (): void => {
    guardRef.current?.jumpToLive();
    virtualizer.scrollToEnd();
  };

  return (
    <div className="tr-island" data-following={live ? '1' : '0'}>
      <div
        ref={scrollRef}
        className="tr-scroller"
        data-testid="tr-scroller"
        tabIndex={0}
        role="log"
        aria-label="session transcript"
      >
        <div className="tr-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            if (item === undefined) return null;
            let arrive = false;
            if (!animatedKeys.has(item.key)) {
              animatedKeys.add(item.key);
              arrive = true;
            }
            return (
              <div
                key={item.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={`tr-row${arrive ? ' tr-arrive' : ''}`}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {renderItem(item)}
              </div>
            );
          })}
        </div>
      </div>
      {live ? (
        <div className="tr-live tr-engraved" data-testid="tr-live">
          live
        </div>
      ) : (
        <button
          type="button"
          className="tr-jump tr-engraved"
          data-testid="tr-jump"
          onClick={jumpToLive}
        >
          jump to live
        </button>
      )}
    </div>
  );
}
