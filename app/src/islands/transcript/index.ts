/**
 * FE-3 transcript island — public surface (plan §5/FE-3, blueprint §8).
 *
 * `TranscriptIsland` renders a `TranscriptFeed`; `createTranscriptStore`
 * (model.ts) is the reference feed the FE-2 stores hydrate from validated
 * `transcript.<sid>` payloads. NOTE: importing the component (or this index)
 * pulls React + CSS — Node-side unit tests import the logic modules
 * (model.ts, followGuard.ts) directly.
 */

export {
  createFollowGuard,
  type FollowGuard,
  type FollowGuardElement,
  type FollowGuardOptions,
  type FrameScheduler,
} from './followGuard.ts';
export {
  createTranscriptStore,
  type TranscriptFeed,
  type TranscriptItem,
  type TranscriptResultItem,
  type TranscriptSnapshot,
  type TranscriptStore,
  type TranscriptTextItem,
  type TranscriptToolItem,
  type TranscriptToolStatus,
} from './model.ts';
export { TranscriptIsland, type TranscriptIslandProps } from './TranscriptIsland.tsx';
