import { describe, expect, it, vi } from 'vitest';

import {
  REDACTED,
  createLogger,
  defaultRedactionFilter,
  monotonicMillis,
  newId,
  type LogRecord,
} from './index.js';

describe('@aibender/shared: newId', () => {
  // -- positive ------------------------------------------------------------

  it('produces <prefix>_<32 hex> ids', () => {
    expect(newId('ws')).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(newId('sn')).toMatch(/^sn_[0-9a-f]{32}$/);
  });

  it('produces unique ids across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('run')));
    expect(ids.size).toBe(1000);
  });

  // -- negative ------------------------------------------------------------

  it('rejects invalid prefixes', () => {
    expect(() => newId('')).toThrow(RangeError);
    expect(() => newId('Ws')).toThrow(RangeError); // uppercase
    expect(() => newId('9lives')).toThrow(RangeError); // leading digit
    expect(() => newId('has space')).toThrow(RangeError);
    expect(() => newId('under_score')).toThrow(RangeError); // _ is the separator
  });

  // -- edge ----------------------------------------------------------------

  it('accepts a 16-char prefix but rejects 17', () => {
    const sixteen = 'a'.repeat(16);
    expect(newId(sixteen)).toMatch(new RegExp(`^${sixteen}_[0-9a-f]{32}$`));
    expect(() => newId('a'.repeat(17))).toThrow(RangeError);
  });
});

describe('@aibender/shared: monotonicMillis', () => {
  it('returns a finite number and never decreases', () => {
    let previous = monotonicMillis();
    expect(Number.isFinite(previous)).toBe(true);
    for (let i = 0; i < 5000; i += 1) {
      const now = monotonicMillis();
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });
});

describe('@aibender/shared: logging + redaction', () => {
  const capture = () => {
    const records: LogRecord[] = [];
    return { records, sink: (r: LogRecord) => records.push(r) };
  };

  // -- positive ------------------------------------------------------------

  it('redacts fields tagged secret or identifier; untagged fields pass through', () => {
    const { records, sink } = capture();
    const log = createLogger({
      sink,
      fieldTags: { token: ['secret'], accountEmail: ['identifier'] },
    });

    // Synthetic values, runtime-built so no scanner-shaped literal is committed.
    const fakeToken = ['fake', 'token', 'value'].join('-');
    log.info('spawned session', {
      token: fakeToken,
      accountEmail: 'MAX_A@example.com',
      account: 'MAX_A',
    });

    expect(records).toHaveLength(1);
    const fields = records[0]?.fields ?? {};
    expect(fields['token']).toBe(REDACTED);
    expect(fields['accountEmail']).toBe(REDACTED);
    expect(fields['account']).toBe('MAX_A');
    // The raw tagged value must not appear anywhere in the serialized record.
    expect(JSON.stringify(records[0])).not.toContain(fakeToken);
  });

  it('carries level, message, and a monotonic timestamp', () => {
    const { records, sink } = capture();
    const log = createLogger({ sink });
    log.warn('pressure amber');
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.msg).toBe('pressure amber');
    expect(records[0]?.monotonicMs).toBeGreaterThanOrEqual(0);
  });

  // -- negative ------------------------------------------------------------

  it('does not write to console when a custom sink is provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { sink } = capture();
      createLogger({ sink }).error('boom', { detail: 'x' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('defaultRedactionFilter replaces any tagged field, keeps untagged', () => {
    expect(
      defaultRedactionFilter({ key: 'k', value: 'v', tags: new Set(['secret']) }),
    ).toBe(REDACTED);
    expect(defaultRedactionFilter({ key: 'k', value: 'v', tags: new Set() })).toBe('v');
  });

  // -- edge ----------------------------------------------------------------

  it('logs with no fields at all, and honors a custom filter', () => {
    const { records, sink } = capture();
    createLogger({ sink }).debug('bare');
    expect(records[0]?.fields).toEqual({});

    const { records: r2, sink: s2 } = capture();
    const log = createLogger({
      sink: s2,
      redact: ({ value, tags }) => (tags.has('secret') ? 'len:' + String(value).length : value),
      fieldTags: { pw: ['secret'] },
    });
    log.info('custom', { pw: 'abcd' });
    expect(r2[0]?.fields['pw']).toBe('len:4');
  });
});
