/**
 * Adapter-fake sanity suite (ICR-0008) — the promoted BE-4 doubles must keep
 * the probed v1.17.13 behaviors the core adapter suites lean on (auth
 * refusal, sync double-delivery, JIT load, synthetic-only fixtures [X2]).
 * The deep behavioral coverage stays where it always ran: the consuming
 * adapter suites in core/src/adapters/.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { startFakeLmStudioServer, type FakeLmStudioServer } from './fakeLmStudio.js';
import { SYNTHETIC_CREDENTIAL_VALUE, buildFakeOpencodeDb } from './fakeOpencodeDb.js';
import { startMockOpencodeServer, type MockOpencodeServer } from './mockOpencodeServer.js';

const open: Array<MockOpencodeServer | FakeLmStudioServer> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

describe('startMockOpencodeServer', () => {
  it('answers 401 without Basic auth and serves /global/health with it', async () => {
    const server = await startMockOpencodeServer({ password: 'synthetic-pw' });
    open.push(server);
    const denied = await fetch(`${server.url}/global/health`);
    expect(denied.status).toBe(401);

    const auth = `Basic ${Buffer.from('opencode:synthetic-pw').toString('base64')}`;
    const allowed = await fetch(`${server.url}/global/health`, {
      headers: { authorization: auth },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ healthy: true, version: '1.17.13-synthetic' });
    expect(server.requests.map((request) => request.authorized)).toEqual([false, true]);
  });

  it('double-delivers durable bus events (plain + sync wrapper, same evt_ id)', async () => {
    const server = await startMockOpencodeServer({ password: 'synthetic-pw' });
    open.push(server);
    const auth = `Basic ${Buffer.from('opencode:synthetic-pw').toString('base64')}`;
    const response = await fetch(`${server.url}/global/event`, {
      headers: { authorization: auth },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (marker: string): Promise<void> => {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('sse stream ended early');
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('server.connected');
    const id = server.emitBusEvent({
      type: 'session.created',
      durable: { aggregateId: 'ses_synth00000001' },
    });
    await readUntil('"type":"sync"');
    const deliveries = text.split('\n\n').filter((frame) => frame.includes(id));
    expect(deliveries).toHaveLength(2); // plain + sync wrapper (probe §2)
    expect(text).toContain('session.created.1');
    await reader.cancel();
  });
});

describe('startFakeLmStudioServer', () => {
  it('JIT-loads a model on chat and reports state via /api/v0/models', async () => {
    const server = await startFakeLmStudioServer();
    open.push(server);
    server.addModel({ key: 'synthetic-model-7b', state: 'not-loaded' });

    const completion = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic-model-7b', ttl: 300, messages: [] }),
    });
    expect(completion.status).toBe(200);
    expect(server.chatRequests[0]).toMatchObject({ model: 'synthetic-model-7b', ttl: 300 });

    const states = await fetch(`${server.url}/api/v0/models`);
    const body = (await states.json()) as { data: Array<{ id: string; state: string }> };
    expect(body.data).toEqual([expect.objectContaining({ id: 'synthetic-model-7b', state: 'loaded' })]);
  });

  it('failNextChat("socket") kills the connection without an HTTP answer', async () => {
    const server = await startFakeLmStudioServer();
    open.push(server);
    server.addModel({ key: 'synthetic-model-7b', state: 'loaded' });
    server.failNextChat('socket');
    await expect(
      fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'synthetic-model-7b', messages: [] }),
      }),
    ).rejects.toThrow();
  });
});

describe('buildFakeOpencodeDb', () => {
  it('builds the probed schema with durable events and SCREAMINGLY fake credentials [X2]', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aibender-testkit-db-')), 'opencode.db');
    const built = buildFakeOpencodeDb({
      path,
      sessions: [{ sessionId: 'ses_synth00000001', eventTypes: ['session.created.1', 'session.next.step.ended.2'] }],
    });
    expect(built.eventCount).toBe(2);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual([
        'account',
        'credential',
        'event',
        'event_sequence',
        'migration',
      ]);
      const secret = db.prepare('SELECT secret FROM credential').get() as { secret: string };
      expect(secret.secret).toBe(SYNTHETIC_CREDENTIAL_VALUE);
      expect(secret.secret).toContain('NOT-A-REAL-SECRET');
    } finally {
      db.close();
    }
  });
});
