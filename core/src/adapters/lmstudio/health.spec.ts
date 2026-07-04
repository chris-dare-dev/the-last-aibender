import { createServer, type Server } from 'node:http';

import { startFakeLmStudioServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { createLmStudioHealthProbe } from './health.js';

describe('LM Studio health probe — down as a FIRST-CLASS state (blueprint §4.3)', () => {
  // -- positive ---------------------------------------------------------------

  it('reports up with a model count', async () => {
    const fake = await startFakeLmStudioServer();
    try {
      fake.addModel({ key: 'synthetic-8b-q4', state: 'not-loaded' });
      const probe = createLmStudioHealthProbe({ baseUrl: fake.url });
      expect(await probe.check()).toEqual({ state: 'up', modelCount: 1 });
    } finally {
      await fake.close();
    }
  });

  // -- negative: down is a VALUE, never a throw --------------------------------

  it('reports down/unreachable when nothing listens (never throws)', async () => {
    // Reserve a port, close the listener, probe the now-dead port.
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const probe = createLmStudioHealthProbe({ baseUrl: `http://127.0.0.1:${String(port)}` });
    expect(await probe.check()).toEqual({ state: 'down', reason: 'unreachable' });
  });

  it('reports down/timeout on a hanging server (SHORT timeout by design)', async () => {
    const server = createServer(() => {
      /* never answer */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const probe = createLmStudioHealthProbe({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        timeoutMs: 50,
      });
      expect(await probe.check()).toEqual({ state: 'down', reason: 'timeout' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports down/http-error on a non-2xx answer', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const probe = createLmStudioHealthProbe({ baseUrl: `http://127.0.0.1:${String(port)}` });
      expect(await probe.check()).toEqual({ state: 'down', reason: 'http-error' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
