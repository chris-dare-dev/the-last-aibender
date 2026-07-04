/**
 * Wire vocabularies shared by every channel and by @aibender/schema CHECK
 * constraints. Labels are placeholders ONLY per [X2] — MAX_A / MAX_B / ENT /
 * AWS_DEV / LOCAL. Real identity mapping is machine-local (@aibender/shared
 * identity map) and never enters the repo or any wire message.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

/** The five account labels (plan FE-5: the picker offers exactly these). */
export const ACCOUNT_LABELS = Object.freeze([
  'MAX_A',
  'MAX_B',
  'ENT',
  'AWS_DEV',
  'LOCAL',
] as const);

export type AccountLabel = (typeof ACCOUNT_LABELS)[number];

/** Session backends (blueprint §5 `session_node.backend`). */
export const BACKENDS = Object.freeze(['claude_code', 'opencode', 'lmstudio'] as const);

export type Backend = (typeof BACKENDS)[number];

/**
 * The one legal backend per account label (blueprint §3/§4): MAX_A/MAX_B/ENT
 * are Claude subscription accounts; AWS_DEV rides OpenCode→Bedrock; LOCAL is
 * LM Studio. A launch that violates this pairing is rejected at validation.
 */
export const LABEL_BACKENDS: Readonly<Record<AccountLabel, Backend>> = Object.freeze({
  MAX_A: 'claude_code',
  MAX_B: 'claude_code',
  ENT: 'claude_code',
  AWS_DEV: 'opencode',
  LOCAL: 'lmstudio',
});

/**
 * Execution substrates (blueprint §4.1): SDK `query()` is the only
 * programmatic substrate; node-pty is the only attended surface, and it is
 * Claude-only (OpenCode is a supervised server, LM Studio is an API).
 */
export const SUBSTRATES = Object.freeze(['sdk', 'pty'] as const);

export type Substrate = (typeof SUBSTRATES)[number];

/**
 * Resume-ledger session states as they appear on the wire (`status` verb).
 * The storage-side legal-transition map lives in @aibender/schema; the state
 * machine itself is prototyped and validated in SPIKE-D (vii)
 * (docs/spikes/spike-d-pty-supervision.md) and specified in
 * docs/contracts/sqlite-ddl.md.
 */
export const SESSION_STATES = Object.freeze([
  'spawning',
  'running',
  'resumed',
  'orphan_detected',
  'orphan_killed',
  'exited',
] as const);

export type SessionState = (typeof SESSION_STATES)[number];

export function isAccountLabel(value: unknown): value is AccountLabel {
  return typeof value === 'string' && (ACCOUNT_LABELS as readonly string[]).includes(value);
}

export function isBackend(value: unknown): value is Backend {
  return typeof value === 'string' && (BACKENDS as readonly string[]).includes(value);
}

export function isSubstrate(value: unknown): value is Substrate {
  return typeof value === 'string' && (SUBSTRATES as readonly string[]).includes(value);
}

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}
