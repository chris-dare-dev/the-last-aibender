import { startFakeLmStudioServer, type FakeLmStudioServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { createLmStudioClient } from './client.js';
import { AMBER_TTL_SECONDS, DEFAULT_TTL_SECONDS, type PressureState } from './residency.js';

async function withFake(run: (fake: FakeLmStudioServer) => Promise<void>): Promise<void> {
  const fake = await startFakeLmStudioServer();
  fake.addModel({ key: 'synthetic-8b-q4', state: 'not-loaded', quantization: 'Q4_K_M' });
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

const MESSAGES = [{ role: 'user' as const, content: 'synthesized prompt' }];

describe('LM Studio /v1 inference routing (BE-4; blueprint §4.3)', () => {
  // -- positive: JIT + TTL riding every request --------------------------------

  it('completes a chat and captures usage + duration + ttl inline', async () => {
    await withFake(async (fake) => {
      fake.setCompletionText('synthesized answer');
      const client = createLmStudioClient({ baseUrl: fake.url });
      const result = await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      expect(result.state).toBe('ok');
      if (result.state !== 'ok') return;
      expect(result.value.content).toBe('synthesized answer');
      expect(result.value.usage).toEqual({
        promptTokens: 12,
        completionTokens: 34,
        totalTokens: 46,
      });
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.value.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
      // The TTL rode the wire — LM Studio's JIT policy sees it per request.
      expect(fake.chatRequests[0]?.ttl).toBe(DEFAULT_TTL_SECONDS);
    });
  });

  it('JIT semantics: the inference request loads the model', async () => {
    await withFake(async (fake) => {
      const client = createLmStudioClient({ baseUrl: fake.url });
      await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      // Observable through the (feature-gated) state read — the fake flips it.
      expect(fake.chatRequests).toHaveLength(1);
    });
  });

  // -- edge: TTL shortened under amber (plan §9.2) ------------------------------

  it('derives 900 s TTL under amber pressure', async () => {
    await withFake(async (fake) => {
      let pressure: PressureState = 'nominal';
      const client = createLmStudioClient({ baseUrl: fake.url, pressureFn: () => pressure });
      await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      pressure = 'amber';
      await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      expect(fake.chatRequests.map((request) => request.ttl)).toEqual([
        DEFAULT_TTL_SECONDS,
        AMBER_TTL_SECONDS,
      ]);
    });
  });

  it('an explicit ttlSeconds overrides the pressure-derived TTL', async () => {
    await withFake(async (fake) => {
      const client = createLmStudioClient({ baseUrl: fake.url });
      await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES, ttlSeconds: 60 });
      expect(fake.chatRequests[0]?.ttl).toBe(60);
    });
  });

  it('fires onModelUsed with the routed model + ttl (residency ledger hook)', async () => {
    await withFake(async (fake) => {
      const used: Array<[string, number]> = [];
      const client = createLmStudioClient({
        baseUrl: fake.url,
        onModelUsed: (model, ttl) => used.push([model, ttl]),
      });
      await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      expect(used).toEqual([['synthetic-8b-q4', DEFAULT_TTL_SECONDS]]);
    });
  });

  // -- edge: down mid-request → down-state, NOT an error (plan §9.2) -----------

  it('answers state:down when the socket dies mid-request', async () => {
    await withFake(async (fake) => {
      fake.failNextChat('socket');
      const client = createLmStudioClient({ baseUrl: fake.url });
      const result = await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      expect(result).toEqual({ state: 'down', reason: 'unreachable' });
    });
  });

  it('answers state:down/timeout when the request exceeds the deadline', async () => {
    // A server that accepts and never answers.
    const { createServer } = await import('node:http');
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const client = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        timeoutMs: 50,
      });
      const result = await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      expect(result).toEqual({ state: 'down', reason: 'timeout' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // -- negative: HTTP errors stay errors (distinct from down) ------------------

  it('maps a 404 unknown-model answer to state:error with the server message', async () => {
    await withFake(async (fake) => {
      const client = createLmStudioClient({ baseUrl: fake.url });
      const result = await client.chat({ model: 'no-such-model', messages: MESSAGES });
      expect(result.state).toBe('error');
      if (result.state !== 'error') return;
      expect(result.status).toBe(404);
      expect(result.message).toContain('no-such-model');
    });
  });

  it('maps a 500 answer to state:error', async () => {
    await withFake(async (fake) => {
      fake.failNextChat('http-500');
      const client = createLmStudioClient({ baseUrl: fake.url });
      const result = await client.chat({ model: 'synthetic-8b-q4', messages: MESSAGES });
      expect(result.state).toBe('error');
      if (result.state !== 'error') return;
      expect(result.status).toBe(500);
    });
  });
});
