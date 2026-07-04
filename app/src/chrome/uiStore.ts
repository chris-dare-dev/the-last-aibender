/**
 * Chrome-level UI state (palette/settings/selection). Deliberately separate
 * from the wire-fed stores in src/lib — closing the palette must never
 * re-render a gauge.
 */

import { createStore } from 'zustand/vanilla';
import type { ChannelId } from './theme/tokens.ts';

export interface UiState {
  readonly paletteOpen: boolean;
  readonly settingsOpen: boolean;
  readonly selectedSessionId: string | undefined;
  readonly focusedChannel: ChannelId | undefined;
  /** Compact-breakpoint overlay toggle for the instruments zone. */
  readonly instrumentsOverlayOpen: boolean;
  openPalette(): void;
  closePalette(): void;
  togglePalette(): void;
  openSettings(): void;
  closeSettings(): void;
  selectSession(sessionId: string | undefined): void;
  focusChannel(channel: ChannelId | undefined): void;
  toggleInstrumentsOverlay(): void;
}

export const uiStore = createStore<UiState>()((set) => ({
  paletteOpen: false,
  settingsOpen: false,
  selectedSessionId: undefined,
  focusedChannel: undefined,
  instrumentsOverlayOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openSettings: () => set({ settingsOpen: true, paletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  selectSession: (selectedSessionId) => set({ selectedSessionId }),
  focusChannel: (focusedChannel) => set({ focusedChannel }),
  toggleInstrumentsOverlay: () =>
    set((s) => ({ instrumentsOverlayOpen: !s.instrumentsOverlayOpen })),
}));

export type UiStore = typeof uiStore;
