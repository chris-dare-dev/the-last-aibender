/**
 * SEC-2 [X2] — the gateway line scrubber redacts BOTH the per-boot token AND
 * every account IDENTITY in the machine-local identity map (emails, org/account
 * UUIDs, AWS ids → placeholder label). Before this fix the scrubber was built
 * with `secretValues: [token]` ONLY — `loadIdentityMap` existed but was never
 * wired, so a mapped email could appear in-clear in a log line.
 *
 * The identity here is CONSTRUCTED AT RUNTIME (never a committed literal), per
 * the repo's fixture policy [X2]. The map is INJECTED (options.loadIdentityMap)
 * so the test never touches the real ~/.aibender identity map.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ControlRequest, SessionStatus } from '@aibender/protocol';
import { parseIdentityMap, type Logger } from '@aibender/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import type {
  GatewayKernel,
  KernelKillResult,
  KernelLaunchResult,
  KernelResumeResult,
} from './kernel.js';
import { startGateway, type GatewayHandle } from './server.js';

// A synthesized identity, assembled at runtime so no email/AWS-id shape is
// ever a committed literal in this file.
const SYNTH_EMAIL = ['owner.synthetic', 'example.invalid'].join('@');
const LABEL = 'MAX_A';

/** identity-map.json text mapping the synth identity → its placeholder label. */
const identityMapJson = JSON.stringify({ [LABEL]: [SYNTH_EMAIL] });

/**
 * A kernel double whose `launch` rejects with a PLAIN Error (not a
 * KernelVerbError) carrying the synthesized identity in its message — this is
 * the "kernel verb threw a non-KernelVerbError" path, which scrubs
 * `error.message` into the broker-side error log's `detail` field.
 */
class ThrowingKernel implements GatewayKernel {
  async launch(): Promise<KernelLaunchResult> {
    throw new Error(`upstream blew up for ${SYNTH_EMAIL} during launch`);
  }
  async resume(): Promise<KernelResumeResult> {
    throw new Error('unused');
  }
  async kill(): Promise<KernelKillResult> {
    throw new Error('unused');
  }
  async status(): Promise<readonly SessionStatus[]> {
    return [];
  }
}

/** A logger that records every emitted message string (post-scrub). */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record =
    () =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push(msg);
      if (fields !== undefined) lines.push(JSON.stringify(fields));
    };
  return {
    lines,
    logger: { debug: record(), info: record(), warn: record(), error: record() },
  };
}

let home: string;
let handle: GatewayHandle | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-scrub-'));
});

afterEach(async () => {
  if (handle !== undefined) await handle.close();
  handle = undefined;
  await rm(home, { recursive: true, force: true });
});

/** Dial + drive a launch that throws, so the broker logs a scrubbed detail. */
async function launchAndWaitForError(url: string, token: string): Promise<void> {
  const ws = new WsClient(`${url}/?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const request: ControlRequest = {
    kind: 'launch',
    id: 'req_scrub_00000001',
    params: {
      accountLabel: LABEL,
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/cwd',
      purpose: 'SEC-2 scrub regression',
    },
  };
  const gotResult = new Promise<void>((resolve) => {
    ws.on('message', (data: Buffer) => {
      const env = JSON.parse(data.toString('utf8')) as { payload?: { kind?: string } };
      if (env.payload?.kind === 'result') resolve();
    });
  });
  ws.send(JSON.stringify({ stream: 'control', channel: 'control', seq: 0, payload: request }));
  await gotResult;
  ws.close();
}

describe('SEC-2 — gateway log scrubber wires the identity map', () => {
  it('redacts a mapped account identity from broker-side log lines', async () => {
    const { logger, lines } = capturingLogger();
    handle = await startGateway({
      kernel: new ThrowingKernel(),
      aibenderHome: home,
      logger,
      loadIdentityMap: () => parseIdentityMap(identityMapJson),
    });

    await launchAndWaitForError(handle.url, handle.token);

    const joined = lines.join('\n');
    // The synthesized identity NEVER appears in-clear...
    expect(joined).not.toContain(SYNTH_EMAIL);
    // ...it was replaced by its placeholder label, and the error path fired.
    expect(joined).toContain(LABEL);
    expect(joined).toContain('non-KernelVerbError');
  });

  it('still redacts even with NO identity map (token-only scrub is preserved)', async () => {
    const { logger, lines } = capturingLogger();
    handle = await startGateway({
      kernel: new ThrowingKernel(),
      aibenderHome: home,
      logger,
      loadIdentityMap: () => parseIdentityMap('{}'), // empty map
    });
    await launchAndWaitForError(handle.url, handle.token);
    // The token never rides a log line...
    expect(lines.join('\n')).not.toContain(handle.token);
    // ...and with no identity mapped, the raw email is NOT scrubbed (fail-open
    // is out of scope here — the scrubber can only redact identities it knows;
    // fail-CLOSED redaction of *tagged* identifiers is the structured-log path).
    expect(lines.join('\n')).toContain(SYNTH_EMAIL);
  });

  it('a loader that THROWS degrades to an empty map — boot does not crash', async () => {
    const { logger } = capturingLogger();
    handle = await startGateway({
      kernel: new ThrowingKernel(),
      aibenderHome: home,
      logger,
      loadIdentityMap: () => {
        throw new Error('synthetic identity-map load failure');
      },
    });
    // Boot succeeded despite the throwing loader.
    expect(handle.port).toBeGreaterThan(0);
    // reloadIdentityScrub is also safe: it keeps the current (empty) map.
    expect(handle.reloadIdentityScrub()).toBe(0);
  });

  it('reloadIdentityScrub picks up a newly provisioned account identity', async () => {
    const { logger, lines } = capturingLogger();
    let mapText = '{}'; // starts empty (no accounts mapped yet)
    handle = await startGateway({
      kernel: new ThrowingKernel(),
      aibenderHome: home,
      logger,
      loadIdentityMap: () => parseIdentityMap(mapText),
    });
    expect(handle.reloadIdentityScrub()).toBe(0);

    // A new account is provisioned → its identity lands in the machine-local
    // map, and the registry-change trigger calls reloadIdentityScrub.
    mapText = identityMapJson;
    expect(handle.reloadIdentityScrub()).toBe(1);

    lines.length = 0;
    await launchAndWaitForError(handle.url, handle.token);
    const joined = lines.join('\n');
    expect(joined).not.toContain(SYNTH_EMAIL); // now redacted
    expect(joined).toContain(LABEL);
  });
});
