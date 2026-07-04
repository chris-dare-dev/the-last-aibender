/**
 * LIVE integration: a REAL `opencode serve` spawn through the supervisor
 * (build-rule 3 exception: health/list/event endpoints ONLY — never
 * message/inference calls; the child is killed when done).
 *
 * Deliberately double-gated so the default suite stays hermetic:
 *   - the opencode binary must exist at ~/.opencode/bin/opencode, AND
 *   - AIBENDER_OPENCODE_LIVE=1 must be set.
 * Run:  AIBENDER_OPENCODE_LIVE=1 pnpm -F aibender-core test serve.live
 *
 * No Bedrock env is injected here (that path is Keychain-gated, T3): the
 * server boots fine without provider credentials for the surfaces we touch.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createOpencodeServeSupervisor } from './serve.js';
import { createOpencodeSseTransport } from './sse.js';

const OPENCODE_BIN = join(homedir(), '.opencode', 'bin', 'opencode');
const LIVE = process.env['AIBENDER_OPENCODE_LIVE'] === '1' && existsSync(OPENCODE_BIN);

describe.runIf(LIVE)('LIVE opencode serve (rule-3 exception; T3-adjacent)', () => {
  it(
    'boots on a random 127.0.0.1 port, authenticates, streams events, dies clean',
    { timeout: 30_000 },
    async () => {
      const supervisor = createOpencodeServeSupervisor({
        liveServeOptIn: true,
        executablePath: OPENCODE_BIN,
        // Minimal live env: opencode (Bun) needs PATH/HOME to boot.
        baseEnv: {
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          TMPDIR: process.env['TMPDIR'],
        },
      });
      const handle = await supervisor.start();
      try {
        expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        // Health: authenticated answer with a version.
        const health = await handle.health();
        expect(health.healthy).toBe(true);
        expect(health.version).toMatch(/^\d+\.\d+\.\d+/);

        // Auth negative: no credentials → 401.
        const unauthed = await fetch(`${handle.url}/global/health`);
        expect(unauthed.status).toBe(401);

        // Event stream: server.connected arrives on subscribe.
        const transport = createOpencodeSseTransport({
          baseUrl: handle.url,
          authHeader: handle.authHeader(),
        });
        const iterator = transport.events()[Symbol.asyncIterator]();
        const first = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('no event within 10 s')), 10_000),
          ),
        ]);
        expect(first.done).toBe(false);
        if (first.done === false) {
          expect(first.value.type).toBe('server.connected');
          expect(first.value.id).toMatch(/^evt_/);
        }
        transport.close();
      } finally {
        const exit = await handle.stop();
        expect(exit.code !== null || exit.signal !== null).toBe(true);
      }
    },
  );
});

describe.runIf(!LIVE)('LIVE opencode serve (skipped)', () => {
  it('is gated behind AIBENDER_OPENCODE_LIVE=1 + an installed binary', () => {
    expect(LIVE).toBe(false);
  });
});
