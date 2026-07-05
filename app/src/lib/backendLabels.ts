/**
 * FE backend-label seam ([X1] scalability; ICR-0016 backend-registry
 * generalization — the BACKEND twin of the ICR-0013 account-registry FE seam).
 *
 * THE PROBLEM this solves: the observability deck and the resource-health
 * instrument each carried a CLOSED `Record<Backend, string>` engraved-label
 * map ({ claude_code: 'CLAUDE', opencode: 'OPENCODE', lmstudio: 'LMSTUDIO' }).
 * Indexed with a registered FOURTH backend id (ICR-0016 lets a new local LLM /
 * backend register a descriptor at runtime) that record returns `undefined`,
 * so a latency row / api-equiv row / resource-health session row for the new
 * backend rendered a blank label. That is the FE face of the OS-1 finding: a
 * new backend was invisible in the cockpit without a code edit here.
 *
 * THE FIX: derive the engraved label from the frozen backend REGISTRY (the
 * `@aibender/protocol` `backendById` / `allBackends` seam), exactly as the
 * channel panels render from the account registry. The three BUILT-INS keep
 * their canonical short engraved labels ({@link BUILTIN_BACKEND_LABELS}) so
 * every existing render is BYTE-IDENTICAL; a registered fourth backend's label
 * is DERIVED from its id, so it surfaces with NO FE edit.
 *
 * [X2] AUDIT INVARIANT (preserved): a derived label is a mechanical
 * uppercasing of a REGISTERED backend id. Backend ids are generic identifiers
 * (never emails / AWS ids / tokens — the registry's `registerBackend` gate and
 * the [X2] policy forbid identity-bearing ids), so a derived label can never
 * be identity-shaped. {@link backendLabel} never emits caller-supplied text —
 * only the built-in constant or the id of an already-registered descriptor.
 */

import { type Backend, type BackendId, backendById } from '@aibender/protocol';

/**
 * The canonical engraved short label for each of the three built-in backends.
 * These are the exact strings the deck + resource-health instrument have
 * rendered since M3, pinned here so the registry-driven path stays
 * byte-identical for the built-ins (`claude_code` reads `CLAUDE`, NOT the
 * id-derived `CLAUDE_CODE`). NOT a validation ceiling — a registered fourth
 * backend does not appear here; its label is derived by {@link deriveLabel}.
 */
export const BUILTIN_BACKEND_LABELS: Readonly<Record<Backend, string>> = Object.freeze({
  claude_code: 'CLAUDE',
  opencode: 'OPENCODE',
  lmstudio: 'LMSTUDIO',
});

/**
 * Derive an engraved label from a backend id: uppercased, with only
 * `[A-Z0-9_]` retained (any other character collapses to `_`). Mechanical and
 * total; the result is a generic character-grid-friendly token. A registered
 * backend id like `local_qwen` reads `LOCAL_QWEN`. Empty/garbage collapses to
 * the id itself uppercased, never a fabricated identity string.
 */
function deriveLabel(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
}

/**
 * The engraved display label for a backend id, resolved through the frozen
 * registry (ICR-0016). REPLACES the closed `Record<Backend, string>` maps that
 * lived in `ObservabilityDeck.tsx` and `ResourceHealthInstrument.tsx`.
 *
 *   - The three built-ins return their canonical short label
 *     ({@link BUILTIN_BACKEND_LABELS}) — byte-identical to the old maps.
 *   - A REGISTERED fourth backend returns a label DERIVED from its id
 *     ({@link deriveLabel}), so it surfaces with no FE edit.
 *   - An UNREGISTERED / unknown id still returns a real label (the derived
 *     form) rather than `undefined`, so a stale wire row never renders blank.
 *
 * Total over any `BackendId`; never emits identity-shaped text [X2].
 */
export function backendLabel(backend: BackendId): string {
  const builtin = BUILTIN_BACKEND_LABELS[backend as Backend];
  if (builtin !== undefined) return builtin;
  // A registered descriptor could name a custom label in future; for now the
  // id-derived form is the display label. Consulting the registry keeps this
  // honest (only a known id ever reaches a derived label in normal flow), but
  // an unregistered id still derives rather than rendering blank.
  const descriptor = backendById(backend);
  return deriveLabel(descriptor?.id ?? backend);
}
