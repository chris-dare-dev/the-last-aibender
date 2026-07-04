import { describe, expect, it } from 'vitest';

import * as adapters from './index.js';

describe('core/src/adapters public surface (BE-4)', () => {
  it('exposes the three backend factories symmetrically', () => {
    expect(typeof adapters.createOpencodeServeSupervisor).toBe('function');
    expect(typeof adapters.createOpencodeSseTransport).toBe('function');
    expect(typeof adapters.createOpencodeSessionClient).toBe('function');
    expect(typeof adapters.openOpencodeDbReadOnly).toBe('function');
    expect(typeof adapters.createLmStudioHealthProbe).toBe('function');
    expect(typeof adapters.createLmStudioClient).toBe('function');
    expect(typeof adapters.createLmStudioApiV0Reader).toBe('function');
    expect(typeof adapters.createLmsCliLifecycle).toBe('function');
    expect(typeof adapters.createResidencyPolicy).toBe('function');
    expect(typeof adapters.createResidencyLedger).toBe('function');
  });

  it('every live side effect has a typed opt-in refusal', () => {
    expect(() =>
      adapters.createOpencodeServeSupervisor({ liveServeOptIn: false as unknown as true }),
    ).toThrow(adapters.LiveServeDisabledError);
    expect(() =>
      adapters.createKeychainSecretFetcher({ liveKeychainOptIn: false as unknown as true }),
    ).toThrow(adapters.LiveKeychainDisabledError);
    expect(() =>
      adapters.createLmsCliLifecycle({ liveCliOptIn: false as unknown as true }),
    ).toThrow(adapters.LiveLmsCliDisabledError);
  });

  it('adapter errors carry protocol error codes (BE-3 answerability)', () => {
    const error = new adapters.AdapterError('bad-request', 'synthetic');
    expect(error.code).toBe('bad-request');
    expect(error.retryable).toBe(false);
    expect(new adapters.ServeStartTimeoutError(5).retryable).toBe(true);
  });
});
