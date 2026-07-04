import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  createLineScrubber,
  createLogger,
  createRedactionFilter,
  parseIdentityMap,
  type LogRecord,
} from './index.js';

// Synthesized fixture identities per [X2] — obviously fake, sanctioned
// placeholder forms only (*@example.com, AWS_DEV_ACCOUNT_ID).
const identityMap = parseIdentityMap(
  JSON.stringify({
    MAX_A: ['max-a@example.com'],
    MAX_B: ['max-b@example.com'],
    AWS_DEV: ['AWS_DEV_ACCOUNT_ID'],
  }),
);

// Runtime-assembled fake secret so no scanner-shaped literal is committed.
const fakeSecret = ['sk', 'fake', 'unit', 'test', 'value'].join('-');

describe('createRedactionFilter (finalized M1 filter)', () => {
  const filter = createRedactionFilter({ identityMap });

  // -- positive --------------------------------------------------------------

  it('blocks secrets unconditionally', () => {
    expect(filter({ key: 'token', value: fakeSecret, tags: new Set(['secret']) })).toBe(REDACTED);
    // secret wins even when combined with identifier:
    expect(
      filter({ key: 'x', value: 'max-a@example.com', tags: new Set(['secret', 'identifier']) }),
    ).toBe(REDACTED);
  });

  it('maps known identifiers to their account label', () => {
    expect(filter({ key: 'email', value: 'max-a@example.com', tags: new Set(['identifier']) })).toBe(
      'MAX_A',
    );
    expect(
      filter({ key: 'awsAccount', value: 'AWS_DEV_ACCOUNT_ID', tags: new Set(['identifier']) }),
    ).toBe('AWS_DEV');
    // normalization applies on lookup:
    expect(filter({ key: 'email', value: ' MAX-B@example.com ', tags: new Set(['identifier']) })).toBe(
      'MAX_B',
    );
  });

  // -- negative --------------------------------------------------------------

  it('redacts unmapped identifiers (fail-closed)', () => {
    expect(
      filter({ key: 'email', value: 'stranger@example.com', tags: new Set(['identifier']) }),
    ).toBe(REDACTED);
    // non-string identifier values are never passed through either:
    expect(filter({ key: 'orgId', value: 12345, tags: new Set(['identifier']) })).toBe(REDACTED);
  });

  it('redacts every identifier when no identity map is wired', () => {
    const bare = createRedactionFilter();
    expect(bare({ key: 'email', value: 'max-a@example.com', tags: new Set(['identifier']) })).toBe(
      REDACTED,
    );
  });

  // -- edge ------------------------------------------------------------------

  it('passes unknown tags and untagged fields through unchanged', () => {
    expect(filter({ key: 'note', value: 'plain', tags: new Set() })).toBe('plain');
    expect(filter({ key: 'metric', value: 42, tags: new Set(['telemetry']) })).toBe(42);
    expect(filter({ key: 'flag', value: null, tags: new Set(['some-future-tag']) })).toBe(null);
  });

  it('wires into createLogger: secret blocked, identifier mapped, rest untouched', () => {
    const records: LogRecord[] = [];
    const log = createLogger({
      sink: (r) => records.push(r),
      redact: createRedactionFilter({ identityMap }),
      fieldTags: { token: ['secret'], accountEmail: ['identifier'], turn: ['telemetry'] },
    });
    log.info('session spawn', {
      token: fakeSecret,
      accountEmail: 'max-a@example.com',
      turn: 7,
      cwd: '/work/repo',
    });
    const fields = records[0]?.fields ?? {};
    expect(fields['token']).toBe(REDACTED);
    expect(fields['accountEmail']).toBe('MAX_A');
    expect(fields['turn']).toBe(7);
    expect(fields['cwd']).toBe('/work/repo');
    expect(JSON.stringify(records[0])).not.toContain(fakeSecret);
    expect(JSON.stringify(records[0])).not.toContain('max-a@example.com');
  });
});

describe('createLineScrubber (raw log lines)', () => {
  // -- positive --------------------------------------------------------------

  it('scrubs secret values and maps identities inside free text', () => {
    const scrub = createLineScrubber({ secretValues: [fakeSecret], identityMap });
    const line = `auth ok token=${fakeSecret} for max-a@example.com in acct aws_dev_account_id`;
    const scrubbed = scrub(line);
    expect(scrubbed).toBe(`auth ok token=${REDACTED} for MAX_A in acct AWS_DEV`);
    expect(scrubbed).not.toContain(fakeSecret);
  });

  it('scrubs repeated and case-varying occurrences', () => {
    const scrub = createLineScrubber({ identityMap });
    expect(scrub('MAX-A@example.com wrote to max-a@example.com')).toBe('MAX_A wrote to MAX_A');
  });

  // -- negative --------------------------------------------------------------

  it('leaves lines without known values untouched', () => {
    const scrub = createLineScrubber({ secretValues: [fakeSecret], identityMap });
    const line = 'nothing sensitive here: hello@nowhere.invalid 123';
    expect(scrub(line)).toBe(line);
  });

  it('ignores empty/blank secret values instead of corrupting the line', () => {
    const scrub = createLineScrubber({ secretValues: ['', fakeSecret] });
    expect(scrub('plain text')).toBe('plain text');
    expect(scrub(fakeSecret)).toBe(REDACTED);
  });

  // -- edge ------------------------------------------------------------------

  it('escapes regex metacharacters in secret values', () => {
    const trickySecret = 'fake+key(1).value*';
    const scrub = createLineScrubber({ secretValues: [trickySecret] });
    expect(scrub(`x ${trickySecret} y`)).toBe(`x ${REDACTED} y`);
    // The metacharacters must not act as a pattern:
    expect(scrub('fakekey1value')).toBe('fakekey1value');
  });

  it('applies longest-first so containing identities are not shadowed', () => {
    const map = parseIdentityMap(
      JSON.stringify({ MAX_A: ['team-max-a@example.com'], MAX_B: ['max-a@example.com'] }),
    );
    const scrub = createLineScrubber({ identityMap: map });
    // The longer identity must map to MAX_A even though its tail matches MAX_B's entry.
    expect(scrub('mail to team-max-a@example.com now')).toBe('mail to MAX_A now');
  });

  it('a scrubber with no inputs is the identity function', () => {
    const scrub = createLineScrubber();
    expect(scrub('anything at all')).toBe('anything at all');
  });
});
