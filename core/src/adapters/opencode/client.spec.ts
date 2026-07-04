import { startMockOpencodeServer, type MockOpencodeServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { AdapterError } from '../errors.js';
import { createOpencodeSessionClient } from './client.js';
import { serveBasicAuthHeader } from './password.js';

const PASSWORD = 'synthetic-client-password';

async function withMock(
  run: (mock: MockOpencodeServer) => Promise<void>,
): Promise<void> {
  const mock = await startMockOpencodeServer({ password: PASSWORD });
  try {
    await run(mock);
  } finally {
    await mock.close();
  }
}

describe('opencode session client (BE-4; @opencode-ai/sdk with parentID pass-through [X4])', () => {
  // -- positive ---------------------------------------------------------------

  it('creates a session and passes parentID through VERBATIM', async () => {
    await withMock(async (mock) => {
      const client = createOpencodeSessionClient({
        baseUrl: mock.url,
        authHeader: serveBasicAuthHeader(PASSWORD),
      });
      const session = await client.createSession({
        parentId: 'ses_synthparent0001',
        title: 'synthesized child session',
      });
      expect(session.nativeSessionId).toMatch(/^ses_synth/);
      expect(session.parentId).toBe('ses_synthparent0001');
      expect(session.title).toBe('synthesized child session');

      const create = mock.requests.find(
        (request) => request.method === 'POST' && request.url.startsWith('/session'),
      );
      expect(create?.authorized).toBe(true);
      expect(create?.body).toEqual({
        parentID: 'ses_synthparent0001',
        title: 'synthesized child session',
      });
    });
  });

  it('omits parentID entirely for a root session (absent, never null)', async () => {
    await withMock(async (mock) => {
      const client = createOpencodeSessionClient({
        baseUrl: mock.url,
        authHeader: serveBasicAuthHeader(PASSWORD),
      });
      const session = await client.createSession({ title: 'root' });
      expect(session.parentId).toBeUndefined();
      const create = mock.requests.find((request) => request.method === 'POST');
      expect(create?.body).toEqual({ title: 'root' });
    });
  });

  it('scopes to a directory instance via ?directory=', async () => {
    await withMock(async (mock) => {
      const client = createOpencodeSessionClient({
        baseUrl: mock.url,
        authHeader: serveBasicAuthHeader(PASSWORD),
      });
      await client.createSession({ directory: '/synthetic/workspace' });
      const create = mock.requests.find((request) => request.method === 'POST');
      expect(create?.url).toContain('directory=%2Fsynthetic%2Fworkspace');
    });
  });

  // -- negative ---------------------------------------------------------------

  it('answers a typed AdapterError on auth rejection', async () => {
    await withMock(async (mock) => {
      const client = createOpencodeSessionClient({
        baseUrl: mock.url,
        authHeader: serveBasicAuthHeader('wrong-password'),
      });
      await expect(client.createSession({})).rejects.toThrow(AdapterError);
    });
  });
});
