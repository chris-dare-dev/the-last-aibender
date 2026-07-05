/**
 * Bootstrap reader (docs/contracts/bootstrap-file.md §2/§4).
 * Positive: valid shape accepted, URL built with encoded token.
 * Negative: every field-constraint violation rejected; provider throw ⇒
 *           "no broker advertised", never an exception.
 * Edge: torn/foreign JSON bodies; boot-identity comparison over each axis.
 */

import { describe, expect, it } from 'vitest';
import {
  bootIdentityOf,
  configuredClaudeAccountsFromBootstrap,
  discoverGateway,
  gatewayWsUrl,
  isGatewayBootstrap,
  sameBootIdentity,
} from './bootstrap.ts';
import { FAKE_GATEWAY_TOKEN, fakeBootstrap } from './testing/fakes.ts';

describe('isGatewayBootstrap', () => {
  it('accepts the contract shape', () => {
    expect(isGatewayBootstrap(fakeBootstrap())).toBe(true);
  });

  it.each([
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['fractional port', { port: 8080.5 }],
    ['string port', { port: '49152' as unknown as number }],
    ['empty token', { token: '' }],
    ['pid 0', { pid: 0 }],
    ['fractional pid', { pid: 1.5 }],
    ['unparseable startedAt', { startedAt: 'not-a-date' }],
  ])('rejects %s', (_name, overrides) => {
    expect(isGatewayBootstrap({ ...fakeBootstrap(), ...overrides })).toBe(false);
  });

  it('is total over torn/foreign values (never throws)', () => {
    for (const value of [undefined, null, 42, 'gateway', [], {}, { port: 1 }]) {
      expect(isGatewayBootstrap(value)).toBe(false);
    }
  });
});

describe('gatewayWsUrl', () => {
  it('targets loopback with the token as a query param (ws-protocol §1)', () => {
    expect(gatewayWsUrl(fakeBootstrap())).toBe(
      `ws://127.0.0.1:49152/?token=${FAKE_GATEWAY_TOKEN}`,
    );
  });

  it('percent-encodes token content', () => {
    const url = gatewayWsUrl(fakeBootstrap({ token: 'a+b/c=' }));
    expect(url).toBe('ws://127.0.0.1:49152/?token=a%2Bb%2Fc%3D');
  });
});

describe('sameBootIdentity', () => {
  it('matches only when token AND pid AND startedAt agree', () => {
    const a = bootIdentityOf(fakeBootstrap());
    expect(sameBootIdentity(a, bootIdentityOf(fakeBootstrap()))).toBe(true);
    expect(sameBootIdentity(a, bootIdentityOf(fakeBootstrap({ token: 'other' })))).toBe(false);
    expect(sameBootIdentity(a, bootIdentityOf(fakeBootstrap({ pid: 999 })))).toBe(false);
    expect(
      sameBootIdentity(a, bootIdentityOf(fakeBootstrap({ startedAt: '2026-07-04T01:00:00.000Z' }))),
    ).toBe(false);
  });
});

describe('discoverGateway', () => {
  it('returns the bootstrap for a valid provider payload', async () => {
    await expect(discoverGateway(async () => fakeBootstrap())).resolves.toEqual(fakeBootstrap());
  });

  it('collapses absent, malformed and throwing providers to undefined', async () => {
    await expect(discoverGateway(async () => undefined)).resolves.toBeUndefined();
    await expect(discoverGateway(async () => ({ torn: true }))).resolves.toBeUndefined();
    await expect(
      discoverGateway(async () => {
        throw new Error('unreadable');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ICR-0014 claudeAccounts carrier (FE reader)', () => {
  // -- structural validation of the optional field -----------------------------

  it('accepts an absent field and an array-of-strings; rejects non-array / non-string', () => {
    expect(isGatewayBootstrap(fakeBootstrap())).toBe(true); // absent ⇒ still valid
    expect(isGatewayBootstrap({ ...fakeBootstrap(), claudeAccounts: [] })).toBe(true);
    expect(isGatewayBootstrap({ ...fakeBootstrap(), claudeAccounts: ['MAX_A', 'ENT'] })).toBe(true);
    expect(isGatewayBootstrap({ ...fakeBootstrap(), claudeAccounts: 'MAX_A' })).toBe(false);
    expect(isGatewayBootstrap({ ...fakeBootstrap(), claudeAccounts: ['MAX_A', 7] })).toBe(false);
    expect(isGatewayBootstrap({ ...fakeBootstrap(), claudeAccounts: [null] })).toBe(false);
  });

  // -- positive: extract the configured labels ---------------------------------

  it('returns the advertised sanctioned labels, in order', async () => {
    const labels = await configuredClaudeAccountsFromBootstrap(async () =>
      fakeBootstrap({ claudeAccounts: ['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D'] }),
    );
    expect(labels).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C', 'MAX_D']);
  });

  // -- fail-closed [X2] --------------------------------------------------------

  it('drops non-form entries fail-closed (email, MAX_AB, lowercase, backend labels, non-string)', async () => {
    const labels = await configuredClaudeAccountsFromBootstrap(async () =>
      fakeBootstrap({
        claudeAccounts: [
          'MAX_A',
          'attacker@example.com',
          'MAX_AB',
          'max_c',
          'AWS_DEV',
          'LOCAL',
          'ENT',
        ],
      }),
    );
    // Only the sanctioned Claude forms survive — AWS_DEV/LOCAL are BACKENDS,
    // not Claude accounts, and never render as a Claude picker entry.
    expect(labels).toEqual(['MAX_A', 'ENT']);
  });

  it('a torn/foreign claudeAccounts collapses the whole file to "no accounts"', async () => {
    // A non-string element fails isGatewayBootstrap ⇒ discoverGateway yields
    // undefined ⇒ no labels (never a partial trust of a corrupt body).
    const labels = await configuredClaudeAccountsFromBootstrap(async () => ({
      ...fakeBootstrap(),
      claudeAccounts: ['MAX_A', 42],
    }));
    expect(labels).toEqual([]);
  });

  // -- edge: absent field, empty list, absent/throwing provider ----------------

  it('returns [] when the field is absent, empty, or nothing is advertised', async () => {
    expect(await configuredClaudeAccountsFromBootstrap(async () => fakeBootstrap())).toEqual([]);
    expect(
      await configuredClaudeAccountsFromBootstrap(async () =>
        fakeBootstrap({ claudeAccounts: [] }),
      ),
    ).toEqual([]);
    expect(await configuredClaudeAccountsFromBootstrap(async () => undefined)).toEqual([]);
    expect(
      await configuredClaudeAccountsFromBootstrap(async () => {
        throw new Error('unreadable');
      }),
    ).toEqual([]);
  });
});
