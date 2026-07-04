/**
 * FE-3 terminal island — public surface (plan §5/FE-3, blueprint §8).
 *
 * `mountTerminalIsland` (xtermDeps.ts) is the real-environment entry; the
 * split modules stay importable for tests and for FE-2 composition typing.
 * NOTE: importing from `./xtermDeps.ts` (or this index) pulls the real xterm
 * bundle — Node-side unit tests import the specific logic modules instead.
 */

export type { PtyOutputChunk, TerminalPtyPort } from './port.ts';
export {
  attachRenderer,
  type AttachRendererOptions,
  type RendererMode,
  type RendererReason,
  type RendererSelection,
  type RendererTelemetryEvent,
  type RendererTerminal,
  type WebglAddonLike,
} from './renderer.ts';
export { OutputStreamTracker, type AcceptAction, type AcceptOutcome } from './streamTracker.ts';
export { readTerminalTokenTheme, type TerminalTokenTheme } from './theme.ts';
export {
  createTerminalIsland,
  type FitAddonLike,
  type IslandTerminal,
  type IslandTerminalAddon,
  type SerializeAddonLike,
  type TerminalDetachState,
  type TerminalInitOptions,
  type TerminalIslandDeps,
  type TerminalIslandHandle,
  type TerminalIslandOptions,
} from './terminalIsland.ts';
export { createDefaultTerminalIslandDeps, mountTerminalIsland } from './xtermDeps.ts';
