/**
 * FE-5 account/backend picker derivation (plan §5/FE-5).
 *
 * [X1] scalability (ICR-0013): the picker enumerates the CONFIGURED account
 * REGISTRY (the FE-2 lib seam `accountRegistry()` — N Claude accounts + the two
 * fixed backend labels), NOT a hardcoded five. Add a Claude Max subscription
 * and it appears here with zero code change.
 *
 * [X2] AUDIT DESIGN: picker options are derived from the registry, whose every
 * entry is a SANCTIONED PLACEHOLDER (a Claude `MAX_<X>`/`ENT` form validated by
 * `isClaudeAccountLabel`, or a fixed backend label) — the registry DROPS every
 * non-form input fail-closed. There is no code path by which caller-supplied
 * identity text (a config file, a status payload, a tampered store) can become
 * picker option text. The only strings this module can ever emit as an account
 * name are sanctioned placeholder labels. The audit render test (audit.spec.ts)
 * pins this for every N.
 *
 * Backend is DERIVED per the frozen label↔backend pairing (`backendForLabel`),
 * so a pairing-violating launch (golden fixture
 * `control-launch-label-backend-mismatch`) is unrepresentable in this UI.
 */

import type { AccountLabel, Backend } from '@aibender/protocol';

import { accountRegistry, type AccountRegistry } from '../../lib/accountRegistry.ts';

export interface AccountPickerOption {
  /** Engraved option text — a sanctioned placeholder label, nothing else. */
  readonly label: AccountLabel;
  /** Derived via the frozen label↔backend pairing; never user-supplied. */
  readonly backend: Backend;
  /** 1-based render slot (registry order: Claude accounts, then backends). */
  readonly slot: number;
  /**
   * Channel index-hue token reference (DESIGN.md §2.5). A `var(--ig-channel-*)`
   * custom property assigned by slot position from the fixed hue palette — an
   * identity tick only, never a fill or text color.
   */
  readonly channelTokenVar: string;
}

/**
 * Derive the picker options from an account registry. Pure over its input; the
 * default (`accountRegistry()`) is the currently-configured registry (seed
 * three until the composition root injects the broker-surfaced set).
 */
export function accountPickerOptions(
  registry: AccountRegistry = accountRegistry(),
): readonly AccountPickerOption[] {
  return Object.freeze(
    registry.entries.map((entry) =>
      Object.freeze({
        label: entry.label,
        backend: entry.backend,
        slot: entry.slot,
        channelTokenVar: entry.channelTokenVar,
      }),
    ),
  );
}
