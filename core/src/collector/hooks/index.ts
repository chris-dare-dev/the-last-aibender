/**
 * BE-5 source 8 — the hooks-contract.md accepting endpoint (loopback HTTP):
 * frozen envelope validation, PermissionRequest → ApprovalBroker hook-floor
 * relay, everything else normalized into the events store.
 */

export { normalizeAcceptedHookPost, type NormalizeHookPostInput } from './normalize.js';

export {
  HOOKS_SERVER_HOST,
  MAX_HOOK_BODY_BYTES,
  startHooksServer,
  type HookFloorApprovalPort,
  type HooksServer,
  type HooksServerOptions,
  type HooksServerStats,
} from './server.js';
