/**
 * ⌘K command palette — the primary verb surface (DESIGN.md §6). Token
 * geometry throughout: 640px width, 160px offset, 28px rows, max 12 rows,
 * raised surface + emphasis hairline + radius-2, flat scrim (no blur),
 * palette-open motion token (120ms fade + 8px settle; instant under
 * reduced motion via the generated CSS remap).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { rankCommands, recordUse, type CommandContext } from './commands.ts';
import { useGatewayClient } from './clientContext.tsx';
import { uiStore } from './uiStore.ts';

const MAX_ROWS = 12; // --ig-palette-max-rows

export function CommandPalette(): ReactNode {
  const open = useStore(uiStore, (s) => s.paletteOpen);
  const closePalette = useStore(uiStore, (s) => s.closePalette);
  const togglePalette = useStore(uiStore, (s) => s.togglePalette);
  const client = useGatewayClient();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global summon: ⌘K (Mod+K) — reachable from anywhere, two keystrokes to
  // any verb (the kill-switch rule).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePalette]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // Palette summon → interactive within the 100ms latency budget: focus
      // synchronously after paint.
      inputRef.current?.focus();
    }
  }, [open]);

  const matches = useMemo(() => rankCommands(query).slice(0, MAX_ROWS), [query, open]);

  if (!open) return null;

  const ctx: CommandContext = { client };

  const runAt = (index: number): void => {
    const spec = matches[index];
    if (spec === undefined) return;
    recordUse(spec.id);
    closePalette();
    spec.run(ctx);
  };

  return (
    <>
      <div className="ig-scrim" data-testid="palette-scrim" onClick={closePalette} />
      <div className="ig-palette" role="dialog" aria-label="command palette" data-testid="command-palette">
        <input
          ref={inputRef}
          className="ig-palette-input"
          data-testid="palette-input"
          value={query}
          placeholder="verb…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              closePalette();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(matches.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runAt(cursor);
            }
          }}
        />
        <ul className="ig-palette-list" data-testid="palette-list">
          {matches.length === 0 ? (
            <li className="ig-palette-empty ig-engraved">NO MATCHING VERB</li>
          ) : (
            matches.map((spec, i) => (
              <li
                key={spec.id}
                className="ig-palette-row"
                data-selected={i === cursor}
                data-testid={`palette-row-${spec.id}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => runAt(i)}
              >
                <span className="ig-palette-marker">›</span>
                <span>{spec.title}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </>
  );
}
