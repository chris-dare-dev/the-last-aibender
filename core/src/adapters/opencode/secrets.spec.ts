import { describe, expect, it } from 'vitest';

import { KeychainItemUnavailableError, LiveKeychainDisabledError } from '../errors.js';
import {
  buildBedrockEnv,
  createKeychainSecretFetcher,
  type ExecFileFn,
  type SecretFetcher,
} from './secrets.js';

const SENTINEL = 'SYNTH-KEYCHAIN-VALUE-93f1-NOT-A-REAL-SECRET';

describe('createKeychainSecretFetcher — live opt-in gated (BE-4 [X2])', () => {
  // -- negative ---------------------------------------------------------------

  it('REFUSES construction without the explicit live opt-in', () => {
    expect(() =>
      createKeychainSecretFetcher({ liveKeychainOptIn: false as unknown as true }),
    ).toThrow(LiveKeychainDisabledError);
    expect(() =>
      createKeychainSecretFetcher({
        liveKeychainOptIn: undefined as unknown as boolean,
      }),
    ).toThrow(LiveKeychainDisabledError);
  });

  it('maps exec failure to a typed error naming the ITEM, never a value', async () => {
    const exec: ExecFileFn = async () => {
      throw new Error('synthetic: item not found');
    };
    const fetcher = createKeychainSecretFetcher({ liveKeychainOptIn: true, execFileFn: exec });
    await expect(fetcher.fetch('synthetic-item-name')).rejects.toThrow(
      KeychainItemUnavailableError,
    );
    await expect(fetcher.fetch('synthetic-item-name')).rejects.toThrow(/synthetic-item-name/);
  });

  it('treats an empty keychain answer as unavailable', async () => {
    const exec: ExecFileFn = async () => ({ stdout: '\n', stderr: '' });
    const fetcher = createKeychainSecretFetcher({ liveKeychainOptIn: true, execFileFn: exec });
    await expect(fetcher.fetch('synthetic-item')).rejects.toThrow(KeychainItemUnavailableError);
  });

  // -- positive ---------------------------------------------------------------

  it("shells the owner's exact read-only pattern: security find-generic-password -s <item> -w", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: ExecFileFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: `${SENTINEL}\n`, stderr: '' };
    };
    const fetcher = createKeychainSecretFetcher({ liveKeychainOptIn: true, execFileFn: exec });
    const value = await fetcher.fetch('bedrock-openai-api-key');
    expect(value).toBe(SENTINEL); // exactly one trailing newline stripped
    expect(calls).toEqual([
      {
        file: 'security',
        args: ['find-generic-password', '-s', 'bedrock-openai-api-key', '-w'],
      },
    ]);
  });
});

describe('buildBedrockEnv — spawn-time assembly (blueprint §4.2)', () => {
  const fakeFetcher = (values: Record<string, string>): SecretFetcher => ({
    fetch: async (item) => {
      const value = values[item];
      if (value === undefined) throw new KeychainItemUnavailableError(item);
      return value;
    },
  });

  // -- positive ---------------------------------------------------------------

  it('assembles plain + keychain env and reports every VALUE to the scrubber tap', async () => {
    const scrubbed: string[] = [];
    const env = await buildBedrockEnv({
      spec: {
        plainEnv: { AWS_PROFILE: 'synthetic-sso-profile', AWS_REGION: 'us-east-1' },
        keychainEnv: [{ envVar: 'OPENAI_API_KEY', keychainItem: 'bedrock-openai-api-key' }],
      },
      secretFetcher: fakeFetcher({ 'bedrock-openai-api-key': SENTINEL }),
      onSecretValue: (value) => scrubbed.push(value),
    });
    expect(env).toEqual({
      AWS_PROFILE: 'synthetic-sso-profile',
      AWS_REGION: 'us-east-1',
      OPENAI_API_KEY: SENTINEL,
    });
    expect(Object.isFrozen(env)).toBe(true);
    // AWS_PROFILE values are identifier-bearing (account-id-embedding) — they
    // go to the scrubber exactly like keychain values [X2].
    expect(scrubbed).toEqual(['synthetic-sso-profile', 'us-east-1', SENTINEL]);
  });

  it('an empty spec yields an empty env (non-Bedrock serve is legal)', async () => {
    const env = await buildBedrockEnv({
      spec: {},
      secretFetcher: fakeFetcher({}),
    });
    expect(env).toEqual({});
  });

  // -- negative ---------------------------------------------------------------

  it('propagates the typed fetch failure (spawn must NOT proceed half-injected)', async () => {
    await expect(
      buildBedrockEnv({
        spec: { keychainEnv: [{ envVar: 'OPENAI_API_KEY', keychainItem: 'missing-item' }] },
        secretFetcher: fakeFetcher({}),
      }),
    ).rejects.toThrow(KeychainItemUnavailableError);
  });
});
