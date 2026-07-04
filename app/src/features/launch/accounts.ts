/**
 * FE-5 account/backend picker derivation (plan §5/FE-5; §9.2 FE-5 positive
 * row: "account picker offers exactly the five labels").
 *
 * [X2] AUDIT DESIGN: picker options are derived from the FROZEN protocol
 * vocabulary (`ACCOUNT_LABELS`, `LABEL_BACKENDS`) and take **zero inputs** —
 * there is no code path by which caller-supplied text (a config file, a
 * status payload, a tampered store) can become picker option text. The only
 * strings this module can ever emit as an account name are the five
 * placeholder labels. The audit render test (audit.spec.ts) pins this.
 *
 * Backend is DERIVED per the frozen label↔backend pairing — the user picks an
 * account, never a backend, so a pairing-violating launch (golden fixture
 * `control-launch-label-backend-mismatch`) is unrepresentable in this UI.
 */

import {
  ACCOUNT_LABELS,
  LABEL_BACKENDS,
  type AccountLabel,
  type Backend,
} from '@aibender/protocol';

export interface AccountPickerOption {
  /** Engraved option text — EXACTLY the placeholder label, nothing else. */
  readonly label: AccountLabel;
  /** Derived via the frozen LABEL_BACKENDS pairing; never user-supplied. */
  readonly backend: Backend;
  /** Fixed slot 1–5 (DESIGN.md §2.5 — instruments never reorder). */
  readonly slot: number;
  /**
   * Channel index-hue token reference (DESIGN.md §2.5). Wire label AWS_DEV
   * maps to the `bedrock` channel token, LOCAL to `lmstudio` — the DESIGN.md
   * channel table names the transport, the wire vocab names the account.
   */
  readonly channelTokenVar: string;
}

/** DESIGN.md §2.5 channel token per wire label (identity ticks only). */
const CHANNEL_TOKEN_VAR: Readonly<Record<AccountLabel, string>> = Object.freeze({
  MAX_A: 'var(--ig-channel-max-a)',
  MAX_B: 'var(--ig-channel-max-b)',
  ENT: 'var(--ig-channel-ent)',
  AWS_DEV: 'var(--ig-channel-bedrock)',
  LOCAL: 'var(--ig-channel-lmstudio)',
});

const OPTIONS: readonly AccountPickerOption[] = Object.freeze(
  ACCOUNT_LABELS.map((label, index) =>
    Object.freeze({
      label,
      backend: LABEL_BACKENDS[label],
      slot: index + 1,
      channelTokenVar: CHANNEL_TOKEN_VAR[label],
    }),
  ),
);

/**
 * The five picker options in frozen slot order. Always exactly
 * `ACCOUNT_LABELS.length` entries; the array and its members are frozen.
 */
export function accountPickerOptions(): readonly AccountPickerOption[] {
  return OPTIONS;
}
