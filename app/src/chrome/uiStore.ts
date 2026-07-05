/**
 * Chrome-level UI state (palette/settings/selection). Deliberately separate
 * from the wire-fed stores in src/lib — closing the palette must never
 * re-render a gauge.
 */

import { createStore } from 'zustand/vanilla';
import type { ChannelId } from './theme/tokens.ts';

/**
 * Center-zone work-surface views (DESIGN.md §4.1: "Center — work: active
 * session (terminal/transcript), graph, builder"). `session` = the selected
 * session's substrate island; `graph` = the FE-4 context-graph island.
 */
export type WorkSurfaceView = 'session' | 'graph';

export interface UiState {
  readonly paletteOpen: boolean;
  readonly settingsOpen: boolean;
  readonly selectedSessionId: string | undefined;
  readonly focusedChannel: ChannelId | undefined;
  /** Compact-breakpoint overlay toggle for the instruments zone. */
  readonly instrumentsOverlayOpen: boolean;
  /** Which view occupies the center work surface. */
  readonly workSurfaceView: WorkSurfaceView;
  openPalette(): void;
  closePalette(): void;
  togglePalette(): void;
  openSettings(): void;
  closeSettings(): void;
  selectSession(sessionId: string | undefined): void;
  focusChannel(channel: ChannelId | undefined): void;
  toggleInstrumentsOverlay(): void;
  setWorkSurfaceView(view: WorkSurfaceView): void;
  toggleGraphView(): void;
}

export const uiStore = createStore<UiState>()((set) => ({
  paletteOpen: false,
  settingsOpen: false,
  selectedSessionId: undefined,
  focusedChannel: undefined,
  instrumentsOverlayOpen: false,
  workSurfaceView: 'session',
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openSettings: () => set({ settingsOpen: true, paletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  selectSession: (selectedSessionId) => set({ selectedSessionId }),
  focusChannel: (focusedChannel) => set({ focusedChannel }),
  toggleInstrumentsOverlay: () =>
    set((s) => ({ instrumentsOverlayOpen: !s.instrumentsOverlayOpen })),
  setWorkSurfaceView: (workSurfaceView) => set({ workSurfaceView }),
  toggleGraphView: () =>
    set((s) => ({ workSurfaceView: s.workSurfaceView === 'graph' ? 'session' : 'graph' })),
}));

export type UiStore = typeof uiStore;
