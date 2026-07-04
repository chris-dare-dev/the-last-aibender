import { describe, expect, it } from 'vitest';

import {
  CONTROL_VERBS,
  RESERVED_CONTROL_VERBS,
  validateControlRequest,
  validateControlResponse,
  validateErrorPayload,
} from './index.js';

const launch = (overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  kind: 'launch',
  id: 'req-001',
  params: {
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate: 'sdk',
    cwd: '/work/repo',
    purpose: 'unit test',
    ...params,
  },
  ...overrides,
});

describe('control verbs: registry', () => {
  it('freezes exactly launch/resume/kill/status, with approve reserved', () => {
    expect([...CONTROL_VERBS].sort()).toEqual(['kill', 'launch', 'resume', 'status']);
    expect([...RESERVED_CONTROL_VERBS]).toEqual(['approve']);
  });
});

describe('validateControlRequest', () => {
  // -- positive --------------------------------------------------------------

  it('accepts a well-formed launch for every legal label/backend pairing', () => {
    const pairings = [
      ['MAX_A', 'claude_code'],
      ['MAX_B', 'claude_code'],
      ['ENT', 'claude_code'],
      ['AWS_DEV', 'opencode'],
      ['LOCAL', 'lmstudio'],
    ] as const;
    for (const [accountLabel, backend] of pairings) {
      const result = validateControlRequest(launch({}, { accountLabel, backend }));
      expect(result.ok, `${accountLabel}/${backend}`).toBe(true);
    }
  });

  it('accepts launch with optional workstreamHint and prompt, and strips unknown keys', () => {
    const result = validateControlRequest(
      launch({ extra: 'dropme' }, { workstreamHint: 'ws_abc', prompt: 'do the thing', junk: 1 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty('extra');
      expect(result.value.kind === 'launch' && result.value.params).not.toHaveProperty('junk');
      if (result.value.kind === 'launch') {
        expect(result.value.params.workstreamHint).toBe('ws_abc');
        expect(result.value.params.prompt).toBe('do the thing');
      }
    }
  });

  it('accepts resume (with and without fork), kill (both modes), status (all forms)', () => {
    expect(
      validateControlRequest({ kind: 'resume', id: 'r1', params: { sessionId: 'ses_1' } }).ok,
    ).toBe(true);
    expect(
      validateControlRequest({ kind: 'resume', id: 'r2', params: { sessionId: 'ses_1', fork: true } }).ok,
    ).toBe(true);
    // ICR-0004: optional next-user-prompt on resume (sdk substrate requires
    // it broker-side; the wire shape carries it here).
    const withPrompt = validateControlRequest({
      kind: 'resume',
      id: 'r3',
      params: { sessionId: 'ses_1', fork: true, prompt: 'continue the thing' },
    });
    expect(withPrompt.ok).toBe(true);
    if (withPrompt.ok && withPrompt.value.kind === 'resume') {
      expect(withPrompt.value.params.prompt).toBe('continue the thing');
      expect(withPrompt.value.params.fork).toBe(true);
    }
    expect(
      validateControlRequest({ kind: 'kill', id: 'k1', params: { sessionId: 'ses_1' } }).ok,
    ).toBe(true);
    expect(
      validateControlRequest({ kind: 'kill', id: 'k2', params: { sessionId: 'ses_1', mode: 'force' } }).ok,
    ).toBe(true);
    expect(validateControlRequest({ kind: 'status', id: 's1' }).ok).toBe(true);
    expect(validateControlRequest({ kind: 'status', id: 's2', params: {} }).ok).toBe(true);
    expect(
      validateControlRequest({ kind: 'status', id: 's3', params: { sessionId: 'ses_1' } }).ok,
    ).toBe(true);
  });

  // -- negative --------------------------------------------------------------

  it('rejects the reserved approve verb with verb-reserved', () => {
    const result = validateControlRequest({ kind: 'approve', id: 'a1', params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('verb-reserved');
  });

  it('rejects unknown verbs with unknown-verb', () => {
    const result = validateControlRequest({ kind: 'reboot', id: 'x1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown-verb');
  });

  it('rejects label/backend pairing violations', () => {
    // MAX_A may never route to Bedrock/OpenCode (blueprint §3/§4).
    const result = validateControlRequest(launch({}, { accountLabel: 'MAX_A', backend: 'opencode' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('bad-request');
      expect(result.message).toContain('pairing');
    }
  });

  it('rejects pty substrate on non-claude backends (attended TUI is claude-only)', () => {
    const result = validateControlRequest(
      launch({}, { accountLabel: 'AWS_DEV', backend: 'opencode', substrate: 'pty' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('claude_code-only');
  });

  it('rejects relative cwd, blank purpose, malformed ids', () => {
    expect(validateControlRequest(launch({}, { cwd: 'relative/path' })).ok).toBe(false);
    expect(validateControlRequest(launch({}, { purpose: '' })).ok).toBe(false);
    expect(validateControlRequest(launch({ id: 'has space' })).ok).toBe(false);
    expect(validateControlRequest(launch({ id: '' })).ok).toBe(false);
    expect(
      validateControlRequest({ kind: 'resume', id: 'r1', params: { sessionId: 'dot.ted' } }).ok,
    ).toBe(false);
    expect(
      validateControlRequest({ kind: 'kill', id: 'k1', params: { sessionId: 'ses_1', mode: 'nuke' } }).ok,
    ).toBe(false);
  });

  it('rejects non-object payloads and missing params', () => {
    expect(validateControlRequest(null).ok).toBe(false);
    expect(validateControlRequest('launch').ok).toBe(false);
    expect(validateControlRequest({ kind: 'launch', id: 'x1' }).ok).toBe(false);
    expect(validateControlRequest({ kind: 'resume', id: 'r1' }).ok).toBe(false);
  });

  // -- edge ------------------------------------------------------------------

  it('accepts a 128-char request id but rejects 129', () => {
    expect(validateControlRequest(launch({ id: 'a'.repeat(128) })).ok).toBe(true);
    expect(validateControlRequest(launch({ id: 'a'.repeat(129) })).ok).toBe(false);
  });

  it('rejects fork as a non-boolean and status params as a non-object', () => {
    expect(
      validateControlRequest({ kind: 'resume', id: 'r1', params: { sessionId: 's1', fork: 'yes' } }).ok,
    ).toBe(false);
    expect(validateControlRequest({ kind: 'status', id: 's1', params: 'all' }).ok).toBe(false);
  });

  it('rejects a resume prompt that is present but empty or non-string (ICR-0004)', () => {
    const empty = validateControlRequest({
      kind: 'resume',
      id: 'r1',
      params: { sessionId: 'ses_1', prompt: '' },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('bad-request');
    expect(
      validateControlRequest({
        kind: 'resume',
        id: 'r2',
        params: { sessionId: 'ses_1', prompt: 42 },
      }).ok,
    ).toBe(false);
    // Absent prompt remains wire-valid — the sdk-substrate requirement is a
    // broker rule, not a validator rule.
    expect(
      validateControlRequest({ kind: 'resume', id: 'r3', params: { sessionId: 'ses_1' } }).ok,
    ).toBe(true);
  });
});

describe('validateControlResponse', () => {
  // -- positive --------------------------------------------------------------

  it('accepts ok results for each verb', () => {
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'req-001',
        ok: true,
        result: { verb: 'launch', sessionId: 'ses_1', state: 'spawning' },
      }).ok,
    ).toBe(true);
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'r2',
        ok: true,
        result: { verb: 'resume', sessionId: 'ses_2', state: 'resumed', forkedFrom: 'ses_1' },
      }).ok,
    ).toBe(true);
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'r3',
        ok: true,
        result: {
          verb: 'status',
          sessions: [
            {
              sessionId: 'ses_1',
              accountLabel: 'MAX_B',
              backend: 'claude_code',
              substrate: 'pty',
              state: 'running',
              cwd: '/work/repo',
              purpose: 'attended',
              pid: 4242,
            },
          ],
        },
      }).ok,
    ).toBe(true);
  });

  it('accepts an error response with a registered code', () => {
    const result = validateControlResponse({
      kind: 'result',
      id: 'r4',
      ok: false,
      error: { code: 'double-resume-blocked', message: 'session ses_1 is running; fork required', retryable: false },
    });
    expect(result.ok).toBe(true);
  });

  // -- negative --------------------------------------------------------------

  it('rejects unregistered error codes and malformed session states', () => {
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'r5',
        ok: false,
        error: { code: 'made-up', message: 'x', retryable: false },
      }).ok,
    ).toBe(false);
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'r6',
        ok: true,
        result: { verb: 'launch', sessionId: 'ses_1', state: 'zombie' },
      }).ok,
    ).toBe(false);
  });

  it('rejects a status result containing one bad session row', () => {
    const result = validateControlResponse({
      kind: 'result',
      id: 'r7',
      ok: true,
      result: {
        verb: 'status',
        sessions: [
          {
            sessionId: 'ses_1',
            accountLabel: 'NOT_A_LABEL',
            backend: 'claude_code',
            substrate: 'sdk',
            state: 'running',
            cwd: '/w',
            purpose: 'p',
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  // -- edge ------------------------------------------------------------------

  it('rejects ok as a non-boolean and pid 0', () => {
    expect(validateControlResponse({ kind: 'result', id: 'r8', ok: 'yes', result: {} }).ok).toBe(false);
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'r9',
        ok: true,
        result: {
          verb: 'status',
          sessions: [
            {
              sessionId: 'ses_1',
              accountLabel: 'MAX_A',
              backend: 'claude_code',
              substrate: 'sdk',
              state: 'running',
              cwd: '/w',
              purpose: 'p',
              pid: 0,
            },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it('accepts an empty status session list', () => {
    expect(
      validateControlResponse({
        kind: 'result',
        id: 'r10',
        ok: true,
        result: { verb: 'status', sessions: [] },
      }).ok,
    ).toBe(true);
  });
});

describe('validateErrorPayload', () => {
  it('accepts a pushed connection-level error with optional correlation', () => {
    expect(
      validateErrorPayload({
        kind: 'error',
        code: 'bad-auth',
        message: 'per-boot token mismatch',
        retryable: false,
      }).ok,
    ).toBe(true);
    expect(
      validateErrorPayload({
        kind: 'error',
        code: 'unknown-channel',
        message: 'no such channel',
        retryable: false,
        correlatesTo: 'req-001',
        channel: 'pty.s01',
      }).ok,
    ).toBe(true);
  });

  it('rejects wrong kind, unknown code, malformed channel', () => {
    expect(
      validateErrorPayload({ kind: 'oops', code: 'bad-auth', message: 'x', retryable: false }).ok,
    ).toBe(false);
    expect(
      validateErrorPayload({ kind: 'error', code: 'nope', message: 'x', retryable: false }).ok,
    ).toBe(false);
    expect(
      validateErrorPayload({
        kind: 'error',
        code: 'bad-auth',
        message: 'x',
        retryable: false,
        channel: 'pty.',
      }).ok,
    ).toBe(false);
  });

  it('rejects an empty message (edge: errors must say something)', () => {
    expect(
      validateErrorPayload({ kind: 'error', code: 'internal', message: '', retryable: true }).ok,
    ).toBe(false);
  });
});
