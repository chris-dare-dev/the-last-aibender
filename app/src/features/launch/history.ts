/**
 * FE-5 launch history — bounded machine-local store (plan §5/FE-5 M2 slice).
 *
 * History is a LOCAL convenience log of dispatch attempts (never a ledger —
 * the resume ledger is broker truth). Bounded ring, newest first, persisted
 * through an injected {@link StorageLike} (the WKWebView `localStorage` in
 * production, a fake in tests; the store never touches a global).
 *
 * [X2] AUDIT DISCIPLINE:
 *   - `accountLabel` is re-validated against the frozen vocabulary at record
 *     AND load time — a tampered persistence layer cannot inject a non-
 *     placeholder account string into anything the views render;
 *   - free-text fields are SHAPE-MASKED at record time
 *     ({@link maskIdentityShapedText}): email-shaped, 12-digit (AWS-account-
 *     shaped) and token-shaped runs are replaced with `[MASKED]` before the
 *     text is stored or rendered. This masks SHAPES client-side as defense in
 *     depth; value-based scrubbing against the machine-local identity map is
 *     @aibender/shared `createLineScrubber` territory (broker-side, where the
 *     map lives).
 */

import { isAccountLabel, isBackend, isErrorCode, isSubstrate } from '@aibender/protocol';
import type { AccountLabel, Backend, ErrorCode, Substrate } from '@aibender/protocol';

import type { Clock } from './ports.ts';

/** Same identity-shape classes the testkit fixture guard screens for. */
const IDENTITY_SHAPED_RES: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, // email-shaped
  /\d{12}/g, // 12-digit run (AWS-account-id shaped)
  /\bsk-[A-Za-z0-9_-]{8,}/g, // token-shaped
];

export const MASKED = '[MASKED]';

/** Replace identity-shaped runs with {@link MASKED}. Idempotent. */
export function maskIdentityShapedText(text: string): string {
  let out = text;
  for (const re of IDENTITY_SHAPED_RES) out = out.replace(re, MASKED);
  return out;
}

export type LaunchHistoryOutcome = 'accepted' | 'wire-error' | 'failed';

export interface LaunchHistoryEntry {
  /** Epoch ms from the injected clock. */
  readonly at: number;
  readonly kind: 'prompt' | 'skill';
  readonly accountLabel: AccountLabel;
  readonly backend: Backend;
  readonly substrate: Substrate;
  readonly cwd: string;
  readonly purpose: string;
  readonly workstreamHint?: string;
  /** Masked + truncated prompt text (never the full prompt). */
  readonly promptPreview: string;
  readonly outcome: LaunchHistoryOutcome;
  /** Harness session id on success. */
  readonly sessionId?: string;
  /** Frozen wire error code on `wire-error`. */
  readonly errorCode?: ErrorCode;
  /** Terse local failure note on `failed` (transport/invalid-response). */
  readonly failureNote?: string;
}

/** Injected persistence seam (localStorage-shaped; fake in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAUNCH_HISTORY_STORAGE_KEY = 'aibender.launch.history.v1';
export const DEFAULT_HISTORY_LIMIT = 50;
export const PROMPT_PREVIEW_CHARS = 120;

export interface LaunchHistoryStoreOptions {
  readonly storage?: StorageLike;
  /** Ring size; oldest entries drop past it. */
  readonly limit?: number;
  readonly now?: Clock;
}

export type HistoryListener = (entries: readonly LaunchHistoryEntry[]) => void;

interface EntryDraft {
  readonly kind: 'prompt' | 'skill';
  readonly accountLabel: AccountLabel;
  readonly backend: Backend;
  readonly substrate: Substrate;
  readonly cwd: string;
  readonly purpose: string;
  readonly workstreamHint?: string;
  readonly promptText: string;
  readonly outcome: LaunchHistoryOutcome;
  readonly sessionId?: string;
  readonly errorCode?: ErrorCode;
  readonly failureNote?: string;
}

export class LaunchHistoryStore {
  readonly #storage: StorageLike | undefined;
  readonly #limit: number;
  readonly #now: Clock;
  #entries: LaunchHistoryEntry[];
  readonly #listeners = new Set<HistoryListener>();

  constructor(options: LaunchHistoryStoreOptions = {}) {
    const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`history limit must be a positive integer, got ${String(limit)}`);
    }
    this.#storage = options.storage;
    this.#limit = limit;
    this.#now = options.now ?? Date.now;
    this.#entries = this.#load();
  }

  /** Newest first. The returned array is a frozen snapshot. */
  list(): readonly LaunchHistoryEntry[] {
    return Object.freeze([...this.#entries]);
  }

  record(draft: EntryDraft): LaunchHistoryEntry {
    if (!isAccountLabel(draft.accountLabel)) {
      throw new RangeError('history refuses a non-placeholder account label [X2]');
    }
    const preview = maskIdentityShapedText(draft.promptText).slice(0, PROMPT_PREVIEW_CHARS);
    const entry: LaunchHistoryEntry = Object.freeze({
      at: this.#now(),
      kind: draft.kind,
      accountLabel: draft.accountLabel,
      backend: draft.backend,
      substrate: draft.substrate,
      cwd: maskIdentityShapedText(draft.cwd),
      purpose: maskIdentityShapedText(draft.purpose),
      ...(draft.workstreamHint !== undefined
        ? { workstreamHint: maskIdentityShapedText(draft.workstreamHint) }
        : {}),
      promptPreview: preview,
      outcome: draft.outcome,
      ...(draft.sessionId !== undefined ? { sessionId: draft.sessionId } : {}),
      ...(draft.errorCode !== undefined ? { errorCode: draft.errorCode } : {}),
      ...(draft.failureNote !== undefined
        ? { failureNote: maskIdentityShapedText(draft.failureNote) }
        : {}),
    });
    this.#entries = [entry, ...this.#entries].slice(0, this.#limit);
    this.#persist();
    this.#notify();
    return entry;
  }

  clear(): void {
    this.#entries = [];
    this.#persist();
    this.#notify();
  }

  subscribe(listener: HistoryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    const snapshot = this.list();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #persist(): void {
    this.#storage?.setItem(LAUNCH_HISTORY_STORAGE_KEY, JSON.stringify(this.#entries));
  }

  /** Corrupt/tampered persisted data resets to empty — never throws. */
  #load(): LaunchHistoryEntry[] {
    const raw = this.#storage?.getItem(LAUNCH_HISTORY_STORAGE_KEY);
    if (raw === null || raw === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const entries: LaunchHistoryEntry[] = [];
    for (const item of parsed) {
      const entry = reviveEntry(item);
      if (entry !== undefined) entries.push(entry);
      if (entries.length >= this.#limit) break;
    }
    return entries;
  }
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Screen one persisted row; malformed or identity-bearing rows are dropped. */
function reviveEntry(item: unknown): LaunchHistoryEntry | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const v = item as Record<string, unknown>;
  const at = v['at'];
  const kind = v['kind'];
  const accountLabel = v['accountLabel'];
  const backend = v['backend'];
  const substrate = v['substrate'];
  const outcome = v['outcome'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (kind !== 'prompt' && kind !== 'skill') return undefined;
  if (!isAccountLabel(accountLabel)) return undefined; // [X2] fail-closed
  if (!isBackend(backend) || !isSubstrate(substrate)) return undefined;
  if (outcome !== 'accepted' && outcome !== 'wire-error' && outcome !== 'failed') return undefined;
  const cwd = v['cwd'];
  const purpose = v['purpose'];
  const promptPreview = v['promptPreview'];
  if (!isNonEmptyString(cwd) || !isNonEmptyString(purpose)) return undefined;
  if (typeof promptPreview !== 'string') return undefined;
  const workstreamHint = v['workstreamHint'];
  const sessionId = v['sessionId'];
  const errorCode = v['errorCode'];
  const failureNote = v['failureNote'];
  return Object.freeze({
    at,
    kind,
    accountLabel,
    backend,
    substrate,
    // Mask again on load — pre-masking-era or tampered rows come out clean.
    cwd: maskIdentityShapedText(cwd),
    purpose: maskIdentityShapedText(purpose),
    ...(isNonEmptyString(workstreamHint)
      ? { workstreamHint: maskIdentityShapedText(workstreamHint) }
      : {}),
    promptPreview: maskIdentityShapedText(promptPreview).slice(0, PROMPT_PREVIEW_CHARS),
    outcome,
    ...(isNonEmptyString(sessionId) ? { sessionId } : {}),
    ...(isErrorCode(errorCode) ? { errorCode } : {}),
    ...(isNonEmptyString(failureNote) ? { failureNote: maskIdentityShapedText(failureNote) } : {}),
  });
}
