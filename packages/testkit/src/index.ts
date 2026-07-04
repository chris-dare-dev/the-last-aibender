/**
 * @aibender/testkit — synthesized fixture generators + fake servers for the
 * whole workspace (plan §3/§9.5; owner BE-ORCH, contributions via ICR).
 *
 * FIXTURE POLICY [X2]: every fixture is SYNTHESIZED — never copied from a real
 * transcript. Fixture identities use only the sanctioned placeholder labels
 * (MAX_A/MAX_B/ENT) and obviously-fake values. This module actively REFUSES
 * to generate identity-bearing text (emails, 12-digit runs, token-shaped
 * strings) so a careless caller cannot launder a real value into a fixture.
 *
 * M0 STUB: the JSONL transcript-line generator. Still to come per plan §3:
 * fake statusline stdin feed, fake OTLP emitter, mock OpenCode SSE server,
 * fake opencode.db builder, golden WS-protocol fixture corpus, fake LM Studio.
 */

/** The only account identities a fixture may carry [X2]. */
export const PLACEHOLDER_ACCOUNTS = Object.freeze(['MAX_A', 'MAX_B', 'ENT'] as const);

export type PlaceholderAccount = (typeof PLACEHOLDER_ACCOUNTS)[number];

/** Fixed synthetic epoch: fixtures are deterministic, not wall-clock-bound. */
const SYNTHETIC_EPOCH_MS = Date.UTC(2026, 0, 1);

// Identity-shaped patterns a synthesized fixture must never contain.
// (Detector regexes only — no literal identity values live in this file.)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const TWELVE_DIGIT_RE = /\d{12}/;
const TOKEN_SHAPED_RE = /\bsk-[A-Za-z0-9_-]{8,}/;

function assertSynthesizedSafeText(text: string): void {
  for (const [what, re] of [
    ['an email address', EMAIL_RE],
    ['a 12-digit run (AWS-account-id shaped)', TWELVE_DIGIT_RE],
    ['a token-shaped string', TOKEN_SHAPED_RE],
  ] as const) {
    if (re.test(text)) {
      throw new RangeError(
        `synthesized fixture text must not contain ${what} [X2 fixture policy]`,
      );
    }
  }
}

export interface SynthesizedJsonlLineOptions {
  /** Placeholder account label. Anything else is refused. Default `MAX_A`. */
  readonly account?: PlaceholderAccount;
  /** Harness-style session id. Default deterministic per (account, seq). */
  readonly sessionId?: string;
  readonly role?: 'user' | 'assistant';
  /** Message text. Screened against identity-shaped patterns. */
  readonly text?: string;
  /** Position in the synthetic transcript; drives uuid + timestamp. Default 0. */
  readonly seq?: number;
}

/**
 * Generate ONE synthesized JSONL transcript line (shape modeled on Claude Code
 * project transcripts: type/uuid/sessionId/timestamp/message). Deterministic
 * for identical options; always a single line; always flagged `synthesized`.
 */
export function synthesizedJsonlLine(options: SynthesizedJsonlLineOptions = {}): string {
  const account = options.account ?? 'MAX_A';
  if (!(PLACEHOLDER_ACCOUNTS as readonly string[]).includes(account)) {
    throw new RangeError(
      `fixture account must be one of ${PLACEHOLDER_ACCOUNTS.join('/')} — got ` +
        `${JSON.stringify(account)} [X2 fixture policy]`,
    );
  }

  const seq = options.seq ?? 0;
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`seq must be a non-negative integer, got ${String(seq)}`);
  }

  const role = options.role ?? 'user';
  const text = options.text ?? `synthesized ${role} turn ${seq} for ${account}`;
  assertSynthesizedSafeText(text);

  const sessionId =
    options.sessionId ?? `synth-${account.toLowerCase().replace('_', '')}-session`;

  const line = {
    synthesized: true as const,
    type: role,
    uuid: `synth-${account.toLowerCase()}-${seq}`,
    sessionId,
    account,
    timestamp: new Date(SYNTHETIC_EPOCH_MS + seq * 1000).toISOString(),
    message: {
      role,
      content: [{ type: 'text' as const, text }],
    },
  };

  return JSON.stringify(line);
}
